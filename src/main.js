// Startup.jobs scraper (production): JSON API first, HTML/JSON-LD fallback, stealth Playwright escalation.
import { Actor, log } from 'apify';
import { Dataset, sleep } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';
import { chromium } from 'playwright';

const ORIGIN = 'https://startup.jobs';
const DEFAULT_LISTING_URL = `${ORIGIN}/remote-jobs`;
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: ORIGIN,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
};

const createLimiter = (maxConcurrency) => {
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= maxConcurrency || queue.length === 0) return;
        active += 1;
        const { task, resolve, reject } = queue.shift();
        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                active -= 1;
                next();
            });
    };

    return (task) =>
        new Promise((resolve, reject) => {
            queue.push({ task, resolve, reject });
            next();
        });
};

const cleanHtmlToText = (html) => {
    if (!html) return null;
    const $ = cheerioLoad(html);
    $('script, style, noscript').remove();
    return $.root().text().replace(/\s+/g, ' ').trim() || null;
};

const toAbsoluteUrl = (maybeUrl, baseUrl = ORIGIN) => {
    if (!maybeUrl) return null;
    try {
        return new URL(maybeUrl, baseUrl).href;
    } catch {
        return null;
    }
};

const cookieHeaderFromPlaywrightCookies = (cookies) => {
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    return cookies
        .filter((c) => c?.name && typeof c.value === 'string')
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
};

const looksLikeCloudflareChallenge = ({ statusCode, headers, bodyText }) => {
    const cfMitigated = String(headers?.['cf-mitigated'] || '').toLowerCase();
    if ((statusCode === 403 || statusCode === 503) && cfMitigated.includes('challenge')) return true;
    if (!bodyText) return false;
    const t = String(bodyText);
    return t.includes('Just a moment...') && t.includes('/cdn-cgi/challenge-platform');
};

const looksLikeCloudflareChallengeHtml = (html) => {
    if (!html) return false;
    const t = String(html);
    return t.includes('Just a moment...') && t.includes('/cdn-cgi/challenge-platform');
};

const waitForCloudflareClearance = async (page, { timeoutMs = 60000 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const html = await page.content().catch(() => null);
        if (html && !looksLikeCloudflareChallengeHtml(html)) return true;
        await page.waitForTimeout(1000);
    }
    return false;
};

const isJobLike = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    const title = obj.title ?? obj.position ?? obj.job_title ?? obj.name;
    const company = obj.company ?? obj.company_name ?? obj.companyName ?? obj.hiringOrganization?.name;
    return typeof title === 'string' && title.trim().length > 0 && (typeof company === 'string' || typeof company === 'object');
};

const findJobArrayDeep = (value, depth = 0) => {
    if (depth > 5 || value == null) return null;
    if (Array.isArray(value)) {
        const jobLikes = value.filter(isJobLike);
        if (jobLikes.length >= Math.min(3, value.length)) return value;
        for (const item of value) {
            const found = findJobArrayDeep(item, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof value !== 'object') return null;
    if (Array.isArray(value.jobs) && value.jobs.some(isJobLike)) return value.jobs;
    if (value.data && Array.isArray(value.data.jobs) && value.data.jobs.some(isJobLike)) return value.data.jobs;
    for (const v of Object.values(value)) {
        const found = findJobArrayDeep(v, depth + 1);
        if (found) return found;
    }
    return null;
};

const tryParseJson = (text) => {
    if (!text || typeof text !== 'string') return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const requestText = async ({ url, method = 'GET', searchParams, json, headers, proxyUrl, cookieHeader, timeoutMs = 30000 }) => {
    const finalHeaders = { ...DEFAULT_HEADERS, ...headers };
    if (cookieHeader) finalHeaders.Cookie = cookieHeader;

    return gotScraping({
        url,
        method,
        headers: finalHeaders,
        searchParams,
        json,
        proxyUrl,
        timeout: { request: timeoutMs },
        throwHttpErrors: false,
        responseType: 'text',
        followRedirect: true,
        retry: { limit: 0 },
    });
};

const requestJson = async (opts) => {
    const res = await requestText(opts);
    const bodyText = res.body;
    if (looksLikeCloudflareChallenge({ statusCode: res.statusCode, headers: res.headers, bodyText })) {
        const err = new Error(`Cloudflare challenge (${res.statusCode})`);
        err.isCloudflare = true;
        err.statusCode = res.statusCode;
        throw err;
    }

    const parsed = tryParseJson(bodyText);
    if (!parsed) {
        const err = new Error(`Non-JSON response (${res.statusCode}) from ${opts.url}`);
        err.statusCode = res.statusCode;
        err.bodySnippet = String(bodyText || '').slice(0, 200);
        throw err;
    }

    if (res.statusCode >= 400) {
        const err = new Error(`HTTP ${res.statusCode} from ${opts.url}`);
        err.statusCode = res.statusCode;
        err.body = parsed;
        throw err;
    }

    return { statusCode: res.statusCode, headers: res.headers, body: parsed };
};

const buildListingUrl = ({ startUrl, keyword, location }) => {
    if (startUrl) return startUrl;
    const u = new URL(DEFAULT_LISTING_URL);
    const normalizedKeyword = (keyword || '').trim();
    const normalizedLocation = (location || '').trim();

    if (normalizedKeyword) u.searchParams.set('q', normalizedKeyword);
    if (!normalizedLocation || normalizedLocation.toLowerCase() === 'remote') {
        u.searchParams.set('w', 'remote');
    }

    return u.href;
};

const parseLdJsonJobPosting = (html) => {
    const $ = cheerioLoad(html);
    const results = [];

    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        const parsed = tryParseJson(raw.trim());
        if (!parsed) return;

        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of candidates) {
            if (c && typeof c === 'object' && (c['@type'] === 'JobPosting' || c.title || c.description)) {
                results.push(c);
            }
        }
    });

    return results[0] || null;
};

const parseNextDataFromHtml = (html) => {
    const $ = cheerioLoad(html);
    const raw = $('#__NEXT_DATA__').first().text()?.trim();
    if (!raw) return null;
    const parsed = tryParseJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const buildId = typeof parsed.buildId === 'string' ? parsed.buildId : null;
    return { buildId, data: parsed };
};

const parseLdJsonItemListUrls = (html, baseUrl) => {
    const $ = cheerioLoad(html);
    const urls = new Set();

    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        const parsed = tryParseJson(raw.trim());
        if (!parsed) return;

        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of candidates) {
            if (!c || typeof c !== 'object') continue;
            if (c['@type'] !== 'ItemList' || !Array.isArray(c.itemListElement)) continue;

            for (const item of c.itemListElement) {
                const maybe = item?.item || item?.url || item;
                const abs = toAbsoluteUrl(typeof maybe === 'string' ? maybe : maybe?.['@id'], baseUrl);
                if (abs) urls.add(abs);
            }
        }
    });

    return Array.from(urls);
};

const normalizeEmploymentType = (value) => {
    if (!value) return null;
    const arr = Array.isArray(value) ? value : [value];
    const cleaned = arr
        .map((v) => (typeof v === 'string' ? v.trim() : null))
        .filter(Boolean)
        .map((v) => v.replace(/_/g, ' '));
    return cleaned.length ? cleaned.join(', ') : null;
};

const extractSalaryFromLd = (jobPosting) => {
    const baseSalary = jobPosting?.baseSalary;
    if (!baseSalary) return null;
    const value = baseSalary?.value?.value ?? baseSalary?.value;
    const currency = baseSalary?.currency;
    if (typeof value === 'number' && currency) return `${currency} ${value}`;
    if (typeof value === 'string') return value;
    return null;
};

const parseJobDetailFromHtml = (html, url) => {
    const $ = cheerioLoad(html);
    const ld = parseLdJsonJobPosting(html);

    const title = ld?.title || $('h1').first().text().trim() || null;
    const company = ld?.hiringOrganization?.name || $('a[href*="/companies/"]').first().text().trim() || null;
    const location =
        ld?.jobLocation?.address?.addressLocality ||
        ld?.jobLocation?.address?.addressRegion ||
        ld?.jobLocation?.address?.addressCountry ||
        null;

    const descriptionHtml = ld?.description || $('main').find('[class*="description"]').first().html() || null;

    return {
        title,
        company,
        location,
        job_type: normalizeEmploymentType(ld?.employmentType) || null,
        salary: extractSalaryFromLd(ld),
        posted_at: ld?.datePosted || null,
        apply_link: toAbsoluteUrl(ld?.hiringOrganization?.sameAs || ld?.url || url, ORIGIN) || url,
        description_html: descriptionHtml,
        description_text: cleanHtmlToText(descriptionHtml),
    };
};

const normalizeJob = ({ rawJob, detail, source }) => {
    const url = toAbsoluteUrl(rawJob?.url || rawJob?.job_url || rawJob?.link || rawJob?.path, ORIGIN);
    const id = String(rawJob?.id || rawJob?.job_id || rawJob?.uuid || rawJob?.slug || url || '').trim() || null;

    const title = rawJob?.title || rawJob?.job_title || rawJob?.position || detail?.title || null;
    const company =
        rawJob?.company?.name ||
        rawJob?.company_name ||
        rawJob?.companyName ||
        rawJob?.company ||
        detail?.company ||
        null;

    const location = rawJob?.location || rawJob?.city || rawJob?.region || detail?.location || null;
    const jobType = rawJob?.employment_type || rawJob?.job_type || rawJob?.type || detail?.job_type || null;
    const salary = rawJob?.salary || rawJob?.salary_range || detail?.salary || null;
    const postedAt = rawJob?.posted_at || rawJob?.published_at || rawJob?.created_at || detail?.posted_at || null;
    const applyLink = toAbsoluteUrl(rawJob?.apply_link || rawJob?.apply_url || rawJob?.applyUrl, ORIGIN) || detail?.apply_link || null;
    const companyLogo = toAbsoluteUrl(rawJob?.company_logo || rawJob?.company?.logo || rawJob?.logo, ORIGIN);

    return {
        id,
        title: title ? String(title).trim() : null,
        company: company ? String(company).trim() : null,
        location: location ? String(location).trim() : null,
        job_type: jobType ? String(jobType).trim() : null,
        salary: salary ? String(salary).trim() : null,
        posted_at: postedAt ? String(postedAt).trim() : null,
        description_text: detail?.description_text || null,
        description_html: detail?.description_html || null,
        company_logo: companyLogo || null,
        apply_link: applyLink || null,
        url: url || null,
        source,
        fetched_at: new Date().toISOString(),
    };
};

const proxyUrlToPlaywrightProxy = (proxyUrl) => {
    if (!proxyUrl) return undefined;
    const u = new URL(proxyUrl);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return username || password ? { server, username, password } : { server };
};

const withRetries = async (label, task, { retries = 2, minDelayMs = 800 } = {}) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await task(attempt);
        } catch (err) {
            lastError = err;
            const shouldRetry = attempt < retries && !err?.isCloudflare;
            if (!shouldRetry) throw err;
            const delay = minDelayMs * (attempt + 1);
            log.warning(`${label} failed (attempt ${attempt + 1}/${retries + 1}): ${err.message}. Retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    throw lastError;
};

const createPlaywrightContext = async ({ proxyUrl }) => {
    const proxy = proxyUrlToPlaywrightProxy(proxyUrl);
    const browser = await chromium.launch({ headless: true, proxy });
    const context = await browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        locale: 'en-US',
        timezoneId: 'UTC',
        viewport: { width: 1365, height: 768 },
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        window.chrome = window.chrome || { runtime: {} };
    });

    await context.route('**/*', async (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) return route.abort();
        return route.continue();
    });

    const close = async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    };

    return { browser, context, close };
};

const playwrightFetchText = async ({ page, url, method = 'GET', headers, bodyText }) => {
    const result = await page.evaluate(
        async ({ url, method, headers, bodyText }) => {
            const res = await fetch(url, {
                method,
                headers: headers || {},
                body: bodyText || undefined,
                credentials: 'include',
                redirect: 'follow',
            });
            return {
                status: res.status,
                contentType: res.headers.get('content-type'),
                text: await res.text(),
                url: res.url,
            };
        },
        { url, method, headers, bodyText },
    );

    return result;
};

const playwrightFetchJson = async ({ page, url, method = 'GET', headers, bodyText }) => {
    const res = await playwrightFetchText({ page, url, method, headers, bodyText });
    if (looksLikeCloudflareChallenge({ statusCode: res.status, headers: {}, bodyText: res.text })) {
        const err = new Error(`Cloudflare challenge (browser fetch ${res.status})`);
        err.isCloudflare = true;
        err.statusCode = res.status;
        throw err;
    }

    const parsed = tryParseJson(res.text);
    if (!parsed) throw new Error(`Browser fetch returned non-JSON (${res.status}) from ${res.url}`);
    if (res.status >= 400) throw new Error(`Browser fetch HTTP ${res.status} from ${res.url}`);
    return parsed;
};

const playwrightTryFetchJson = async ({ page, url, method = 'GET', headers, bodyText }) => {
    try {
        return await playwrightFetchJson({ page, url, method, headers, bodyText });
    } catch {
        return null;
    }
};

const bootstrapSessionWithPlaywright = async ({ listingUrl, proxyUrl }) => {
    const { browser, context, close } = await createPlaywrightContext({ proxyUrl });

    try {
        const page = await context.newPage();

        const candidates = [];
        const seenCandidateUrls = new Set();

        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (!url.startsWith(ORIGIN)) return;
                const headers = response.headers();
                const contentType = String(headers['content-type'] || '').toLowerCase();
                const isLikelyJson = contentType.includes('json') || url.includes('/api/');
                if (!isLikelyJson) return;
                if (seenCandidateUrls.has(url)) return;

                const text = await response.text().catch(() => null);
                const json = text ? tryParseJson(text) : null;
                if (!json) return;

                const jobs = findJobArrayDeep(json);
                if (!jobs || !Array.isArray(jobs) || jobs.length === 0) return;

                const req = response.request();
                const reqHeaders = await req.allHeaders().catch(() => ({}));
                candidates.push({
                    url,
                    method: req.method(),
                    headers: reqHeaders,
                    postData: req.postData(),
                    sampleJson: json,
                    sampleJobs: jobs,
                });
                seenCandidateUrls.add(url);
            } catch {
                // ignore noisy responses
            }
        });

        log.info(`Playwright bootstrap: opening ${listingUrl}`);
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForCloudflareClearance(page, { timeoutMs: 60000 });

        const start = Date.now();
        while (Date.now() - start < 5000 && candidates.length === 0) {
            await sleep(500);
        }

        const cookies = await context.cookies().catch(() => []);
        const cookieHeader = cookieHeaderFromPlaywrightCookies(cookies.filter((c) => String(c.domain || '').includes('startup.jobs')));

        const best = candidates.sort((a, b) => (b.sampleJobs?.length || 0) - (a.sampleJobs?.length || 0))[0] || null;
        if (!best) {
            log.warning('Playwright bootstrap did not detect a jobs JSON response. Will still use cookies for HTTP calls.');
        } else {
            log.info(`Playwright bootstrap: detected jobs API call ${best.method} ${best.url} (${best.sampleJobs.length} items)`);
        }

        await page.close().catch(() => {});

        return { cookieHeader, apiTemplate: best };
    } finally {
        await close();
    }
};

const fetchJobsViaPlaywrightKnownApi = async ({ listingUrl, keyword, maxPages, proxyUrl }) => {
    const { context, close } = await createPlaywrightContext({ proxyUrl });
    const page = await context.newPage();

    try {
        log.info(`Playwright API mode: opening ${listingUrl}`);
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForCloudflareClearance(page, { timeoutMs: 60000 });
        await page.waitForTimeout(1500);

        // Prefer Next.js data endpoint if available (often the real internal JSON source).
        const html = await page.content().catch(() => null);
        const next = html ? parseNextDataFromHtml(html) : null;
        const listing = new URL(listingUrl);
        if (next?.buildId) {
            const allJobs = [];
            for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
                const nextDataUrl = new URL(`${ORIGIN}/_next/data/${next.buildId}${listing.pathname}.json`);
                for (const [k, v] of listing.searchParams.entries()) nextDataUrl.searchParams.set(k, v);
                nextDataUrl.searchParams.set('page', String(pageNumber));
                if ((keyword || '').trim()) nextDataUrl.searchParams.set('q', keyword.trim());

                const json = await playwrightTryFetchJson({
                    page,
                    url: nextDataUrl.href,
                    headers: { accept: 'application/json, text/plain, */*' },
                });

                const jobs = json ? findJobArrayDeep(json) : null;
                const arr = Array.isArray(jobs) ? jobs : [];
                if (arr.length === 0) break;
                allJobs.push(...arr);
            }

            if (allJobs.length > 0) return allJobs;
        }

        const allJobs = [];
        const candidatePaths = ['/api/jobs', '/api/jobs.json', '/api/search/jobs', '/api/job_posts', '/api/postings', '/api/v1/jobs'];

        for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
            let pageJobs = null;
            for (const path of candidatePaths) {
                const apiUrl = new URL(`${ORIGIN}${path}`);
                if (listing.searchParams.get('w')) apiUrl.searchParams.set('w', listing.searchParams.get('w'));
                if ((keyword || '').trim()) apiUrl.searchParams.set('q', keyword.trim());
                apiUrl.searchParams.set('page', String(pageNumber));

                const json = await playwrightTryFetchJson({
                    page,
                    url: apiUrl.href,
                    headers: { accept: 'application/json, text/plain, */*' },
                });
                if (!json) continue;

                const jobs = findJobArrayDeep(json) || (Array.isArray(json) ? json : null);
                const arr = Array.isArray(jobs) ? jobs : [];
                if (arr.length > 0) {
                    pageJobs = arr;
                    break;
                }
            }

            if (!pageJobs || pageJobs.length === 0) break;
            allJobs.push(...pageJobs);
        }

        return allJobs;
    } finally {
        await page.close().catch(() => {});
        await close();
    }
};

const fetchDetailViaPlaywrightContext = async ({ context, url }) => {
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForCloudflareClearance(page, { timeoutMs: 20000 });
        const html = await page.content();
        return parseJobDetailFromHtml(html, url);
    } finally {
        await page.close().catch(() => {});
    }
};

const fetchJobLinksViaPlaywrightListing = async ({ listingUrl, proxyUrl, limit }) => {
    const { context, close } = await createPlaywrightContext({ proxyUrl });
    const page = await context.newPage();
    try {
        log.info(`Playwright HTML mode: opening ${listingUrl}`);
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForCloudflareClearance(page, { timeoutMs: 60000 });
        await page.waitForTimeout(1500);
        for (let i = 0; i < 3; i += 1) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1000);
        }
        const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')).filter(Boolean));
        const urls = new Set();
        for (const href of hrefs) {
            try {
                const abs = new URL(href, listingUrl).href;
                urls.add(abs);
            } catch {
                // ignore
            }
        }
        return Array.from(urls).filter(isLikelyJobUrl).slice(0, limit);
    } finally {
        await page.close().catch(() => {});
        await close();
    }
};

const sanitizeForwardHeaders = (headers) => {
    const banned = new Set([
        'host',
        'content-length',
        'connection',
        'accept-encoding',
        'sec-fetch-site',
        'sec-fetch-mode',
        'sec-fetch-dest',
        'sec-ch-ua',
        'sec-ch-ua-mobile',
        'sec-ch-ua-platform',
        'upgrade-insecure-requests',
        'origin',
    ]);

    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        const key = String(k).toLowerCase();
        if (banned.has(key)) continue;
        out[key] = v;
    }
    return out;
};

const parsePostDataForJson = (postData) => {
    if (!postData) return null;
    const asString = String(postData);
    const parsed = tryParseJson(asString);
    if (parsed) return parsed;
    try {
        const params = new URLSearchParams(asString);
        const obj = Object.fromEntries(params.entries());
        return Object.keys(obj).length ? obj : null;
    } catch {
        return null;
    }
};

const buildPagedRequestFromTemplate = ({ apiTemplate, pageNumber }) => {
    const u = new URL(apiTemplate.url);
    if (u.searchParams.has('page')) u.searchParams.set('page', String(pageNumber));

    let json = null;
    const postJson = parsePostDataForJson(apiTemplate.postData);
    if (postJson && typeof postJson === 'object') {
        json = { ...postJson };
        if ('page' in json) json.page = pageNumber;
        if ('pageNumber' in json) json.pageNumber = pageNumber;
        if ('page_number' in json) json.page_number = pageNumber;
    }

    return { url: u.href, method: apiTemplate.method || 'GET', json };
};

const fetchJobsViaKnownApi = async ({ keyword, listingUrl, pageNumber, proxyUrl, cookieHeader }) => {
    const apiUrl = `${ORIGIN}/api/jobs`;
    const u = new URL(apiUrl);
    const listing = new URL(listingUrl);

    if (listing.searchParams.get('w')) u.searchParams.set('w', listing.searchParams.get('w'));
    if ((keyword || '').trim()) u.searchParams.set('q', keyword.trim());
    u.searchParams.set('page', String(pageNumber));

    const { body } = await requestJson({
        url: u.href,
        headers: { Referer: listingUrl, Accept: 'application/json, text/plain, */*' },
        proxyUrl,
        cookieHeader,
        timeoutMs: 45000,
    });

    const jobs = findJobArrayDeep(body) || (Array.isArray(body) ? body : null);
    return Array.isArray(jobs) ? jobs : [];
};

const isLikelyJobUrl = (url) => {
    try {
        const u = new URL(url);
        if (u.origin !== ORIGIN) return false;
        const p = u.pathname.toLowerCase();
        if (p.includes('/apply')) return false;
        if (p.startsWith('/companies/')) return false;
        if (p.startsWith('/tags/')) return false;
        if (p.startsWith('/roles/')) return false;
        if (p.startsWith('/locations/')) return false;
        if (p === '/' || p === '/remote-jobs') return false;
        return /-\d+$/.test(p) || p.includes('/jobs/') || p.includes('/job/');
    } catch {
        return false;
    }
};

const fetchJobLinksViaHtmlListing = async ({ listingUrl, proxyUrl, cookieHeader, limit }) => {
    const res = await requestText({
        url: listingUrl,
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: ORIGIN },
        proxyUrl,
        cookieHeader,
        timeoutMs: 60000,
    });

    if (looksLikeCloudflareChallenge({ statusCode: res.statusCode, headers: res.headers, bodyText: res.body })) {
        const err = new Error(`Cloudflare challenge (${res.statusCode})`);
        err.isCloudflare = true;
        throw err;
    }

    if (res.statusCode !== 200) throw new Error(`Listing HTML status ${res.statusCode}`);

    const ldUrls = parseLdJsonItemListUrls(res.body, listingUrl);
    const urls = new Set(ldUrls.filter(isLikelyJobUrl));

    if (urls.size === 0) {
        const $ = cheerioLoad(res.body);
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const abs = toAbsoluteUrl(href, listingUrl);
            if (abs && isLikelyJobUrl(abs)) urls.add(abs);
        });
    }

    return Array.from(urls).slice(0, limit);
};

const fetchDetailViaHtml = async ({ url, proxyUrl, cookieHeader }) => {
    const res = await requestText({
        url,
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: ORIGIN },
        proxyUrl,
        cookieHeader,
        timeoutMs: 45000,
    });

    if (looksLikeCloudflareChallenge({ statusCode: res.statusCode, headers: res.headers, bodyText: res.body })) {
        const err = new Error(`Cloudflare challenge (${res.statusCode})`);
        err.isCloudflare = true;
        throw err;
    }

    if (res.statusCode !== 200) return null;
    return parseJobDetailFromHtml(res.body, url);
};

const fetchDetailViaPlaywright = async ({ url, proxyUrl }) => {
    const proxy = proxyUrlToPlaywrightProxy(proxyUrl);
    const browser = await chromium.launch({ headless: true, proxy });
    try {
        const context = await browser.newContext({
            userAgent: DEFAULT_USER_AGENT,
            locale: 'en-US',
            timezoneId: 'UTC',
            viewport: { width: 1365, height: 768 },
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = window.chrome || { runtime: {} };
        });

        const page = await context.newPage();
        await page.route('**/*', async (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font'].includes(type)) return route.abort();
            return route.continue();
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const html = await page.content();
        await page.close();
        await context.close();

        return parseJobDetailFromHtml(html, url);
    } finally {
        await browser.close();
    }
};

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrl,
        keyword = '',
        location = 'Remote',
        collectDetails = true,
        results_wanted: resultsWantedRaw = 25,
        max_pages: maxPagesRaw = 3,
        maxConcurrency: maxConcurrencyRaw = 2,
        proxyConfiguration,
    } = input;

    const resultsWanted = Math.max(1, Number(resultsWantedRaw) || 1);
    const maxPages = Math.max(1, Number(maxPagesRaw) || 1);
    const maxConcurrency = Math.max(1, Number(maxConcurrencyRaw) || 1);

    const listingUrl = buildListingUrl({ startUrl, keyword, location });
    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
    const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;

    const startTime = Date.now();
    const stats = {
        jobsSaved: 0,
        pagesProcessed: 0,
        apiCalls: 0,
        detailCalls: 0,
        playwrightBootstraps: 0,
        errors: 0,
        usedPlaywright: false,
        usedHtml: false,
        usedApi: false,
    };

    const seen = new Set();
    const limiter = createLimiter(maxConcurrency);

    let cookieHeader = null;
    let apiTemplate = null;
    let apiBlockedByCloudflare = false;

    // JSON API first (fast path). If Cloudflare blocks, bootstrap cookies and discover internal API via Playwright.
    const ensureApiAccess = async () => {
        let needsBootstrap = true;
        try {
            stats.apiCalls += 1;
            const jobs = await fetchJobsViaKnownApi({ keyword, listingUrl, pageNumber: 1, proxyUrl, cookieHeader: null });
            if (jobs.length > 0) {
                stats.usedApi = true;
                needsBootstrap = false;
            }
        } catch (err) {
            if (!err?.isCloudflare) {
                log.warning(`Initial API probe failed (non-CF): ${err.message}`);
                needsBootstrap = true;
            }
        }

        if (!needsBootstrap) return;

        stats.playwrightBootstraps += 1;
        stats.usedPlaywright = true;
        const boot = await bootstrapSessionWithPlaywright({ listingUrl, proxyUrl });
        cookieHeader = boot.cookieHeader;
        apiTemplate = boot.apiTemplate;
    };

    await ensureApiAccess();

    const pushOne = async (job) => {
        const key = job?.id || job?.url;
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        await Dataset.pushData(job);
        stats.jobsSaved += 1;
        return true;
    };

    const fetchAndStore = async (rawJob, source, { forceDetails = false } = {}) => {
        if (stats.jobsSaved >= resultsWanted) return;

        const url = toAbsoluteUrl(rawJob?.url || rawJob?.job_url || rawJob?.link || rawJob?.path, ORIGIN);
        let detail = null;

        if ((collectDetails || forceDetails) && url) {
            stats.detailCalls += 1;
            detail = await withRetries(
                'Detail',
                async () => {
                    try {
                        stats.usedHtml = true;
                        return await fetchDetailViaHtml({ url, proxyUrl, cookieHeader });
                    } catch (err) {
                        if (!err?.isCloudflare) throw err;
                        stats.usedPlaywright = true;
                        return await fetchDetailViaPlaywright({ url, proxyUrl });
                    }
                },
                { retries: 1, minDelayMs: 1200 },
            ).catch((err) => {
                stats.errors += 1;
                log.warning(`Detail failed for ${url}: ${err.message}`);
                return null;
            });
        }

        const job = normalizeJob({ rawJob, detail, source });
        await pushOne(job);
    };

    const processRawJobs = async (rawJobs, source, { forceDetails = false } = {}) => {
        const tasks = rawJobs.map((rawJob) =>
            limiter(async () => {
                if (stats.jobsSaved >= resultsWanted) return;
                await fetchAndStore(rawJob, source, { forceDetails });
            }),
        );
        await Promise.all(tasks);
    };

    let apiSucceeded = false;

    // Known internal API endpoint (fast). Reuse cookies when available.
    for (let pageNumber = 1; pageNumber <= maxPages && stats.jobsSaved < resultsWanted; pageNumber += 1) {
        stats.pagesProcessed = pageNumber;
        try {
            stats.apiCalls += 1;
            const jobs = await fetchJobsViaKnownApi({ keyword, listingUrl, pageNumber, proxyUrl, cookieHeader });
            if (jobs.length === 0) break;
            stats.usedApi = true;
            apiSucceeded = true;
            log.info(`API page ${pageNumber}: ${jobs.length} items (saved ${stats.jobsSaved}/${resultsWanted})`);
            const before = stats.jobsSaved;
            await processRawJobs(jobs, cookieHeader ? 'api+cookie' : 'api');
            if (stats.jobsSaved === before) {
                log.info('No new jobs were added from this API page; stopping pagination.');
                break;
            }
        } catch (err) {
            if (err?.isCloudflare) {
                apiBlockedByCloudflare = true;
                log.warning(`API blocked by Cloudflare on page ${pageNumber}. Switching to Playwright-derived API template if available.`);
                break;
            }
            stats.errors += 1;
            log.warning(`API page ${pageNumber} failed: ${err.message}`);
            break;
        }
    }

    // If the fixed endpoint didn’t work, call the discovered internal API template (still JSON HTTP).
    if (!apiSucceeded && apiTemplate && stats.jobsSaved < resultsWanted) {
        log.info('Using Playwright-discovered internal API template (HTTP JSON parsing).');
        for (let pageNumber = 1; pageNumber <= maxPages && stats.jobsSaved < resultsWanted; pageNumber += 1) {
            stats.pagesProcessed = Math.max(stats.pagesProcessed, pageNumber);
            const req = buildPagedRequestFromTemplate({ apiTemplate, pageNumber });
            const forwardHeaders = sanitizeForwardHeaders(apiTemplate.headers);
            try {
                stats.apiCalls += 1;
                const { body } = await requestJson({
                    url: req.url,
                    method: req.method,
                    json: req.json,
                    headers: { ...forwardHeaders, Referer: listingUrl, Accept: 'application/json, text/plain, */*' },
                    proxyUrl,
                    cookieHeader,
                    timeoutMs: 60000,
                });
                const jobs = findJobArrayDeep(body);
                if (!jobs || jobs.length === 0) break;
                stats.usedApi = true;
                log.info(`Discovered API page ${pageNumber}: ${jobs.length} items (saved ${stats.jobsSaved}/${resultsWanted})`);
                const before = stats.jobsSaved;
                await processRawJobs(jobs, 'api-discovered');
                if (stats.jobsSaved === before) {
                    log.info('No new jobs were added from this discovered API page; stopping pagination.');
                    break;
                }
            } catch (err) {
                stats.errors += 1;
                log.warning(`Discovered API page ${pageNumber} failed: ${err.message}`);
                break;
            }
        }
    }

    // Pure HTML fallback: fetch listing HTML -> extract job URLs -> fetch details (HTML), and if blocked use Playwright.
    if (stats.jobsSaved < resultsWanted) {
        try {
            stats.usedHtml = true;
            const linkLimit = Math.min(resultsWanted * 3, 300);
            const links = await fetchJobLinksViaHtmlListing({
                listingUrl,
                proxyUrl,
                cookieHeader,
                limit: linkLimit,
            });

            if (links.length) {
                if (!collectDetails) {
                    log.warning('HTML listing fallback requires visiting job detail pages; overriding collectDetails=false for fallback mode.');
                }
                log.info(`HTML listing fallback: found ${links.length} job URLs`);
                await processRawJobs(links.map((u) => ({ url: u })), 'html-listing', { forceDetails: true });
            }
        } catch (err) {
            if (err?.isCloudflare) {
                log.warning('HTML listing fallback blocked by Cloudflare; rely on Playwright bootstrapped API/detail fallbacks.');
            } else {
                stats.errors += 1;
                log.warning(`HTML listing fallback failed: ${err.message}`);
            }
        }
    }

    // Playwright-first hybrid fallback: use real browser fetch against internal API when HTTP is Cloudflare-blocked.
    if (stats.jobsSaved < resultsWanted && (apiBlockedByCloudflare || stats.usedPlaywright)) {
        try {
            stats.usedPlaywright = true;
            let jobs = [];
            try {
                jobs = await fetchJobsViaPlaywrightKnownApi({ listingUrl, keyword, maxPages, proxyUrl });
            } catch (err) {
                log.warning(`Playwright API mode failed: ${err.message}. Falling back to Playwright HTML mode.`);
            }

            if (jobs.length) {
                stats.usedApi = true;
                log.info(`Playwright API mode: fetched ${jobs.length} jobs via internal API`);
                await processRawJobs(jobs, 'api-playwright');
            }

            if (stats.jobsSaved < resultsWanted) {
                const linkLimit = Math.min(resultsWanted * 3, 300);
                const links = await fetchJobLinksViaPlaywrightListing({ listingUrl, proxyUrl, limit: linkLimit });
                if (links.length) {
                    log.info(`Playwright HTML mode: found ${links.length} job URLs`);

                    // In Playwright HTML mode, details are required to produce meaningful output.
                    const { context, close } = await createPlaywrightContext({ proxyUrl });
                    try {
                        const tasks = links.slice(0, resultsWanted).map((u) =>
                            limiter(async () => {
                                if (stats.jobsSaved >= resultsWanted) return;
                                stats.detailCalls += 1;
                                const detail = await fetchDetailViaPlaywrightContext({ context, url: u }).catch((err) => {
                                    stats.errors += 1;
                                    log.warning(`Playwright detail failed for ${u}: ${err.message}`);
                                    return null;
                                });
                                const job = normalizeJob({ rawJob: { url: u }, detail, source: 'html-playwright' });
                                await pushOne(job);
                            }),
                        );
                        await Promise.all(tasks);
                    } finally {
                        await close();
                    }
                }
            }
        } catch (err) {
            stats.errors += 1;
            log.warning(`Playwright API fallback failed: ${err.message}`);
        }
    }

    const runtimeSeconds = (Date.now() - startTime) / 1000;
    log.info('='.repeat(60));
    log.info('STARTUP.JOBS SCRAPER SUMMARY');
    log.info('='.repeat(60));
    log.info(`Jobs saved: ${stats.jobsSaved}/${resultsWanted}`);
    log.info(`Pages processed: ${stats.pagesProcessed}/${maxPages}`);
    log.info(`API calls: ${stats.apiCalls}`);
    log.info(`Detail calls: ${stats.detailCalls}`);
    log.info(`Playwright bootstraps: ${stats.playwrightBootstraps}`);
    log.info(`Errors: ${stats.errors}`);
    log.info(`Runtime: ${runtimeSeconds.toFixed(2)}s`);
    log.info(`Sources: api=${stats.usedApi} html=${stats.usedHtml} playwright=${stats.usedPlaywright}`);
    log.info('='.repeat(60));

    await Actor.setValue('OUTPUT_SUMMARY', { ...stats, runtimeSeconds, listingUrl });

    if (stats.jobsSaved === 0) {
        await Actor.setValue('NO_RESULTS', true);
        log.warning(
            'No jobs were scraped. Startup.jobs is Cloudflare-protected; enable Apify Proxy (RESIDENTIAL) or allow Playwright fallback to obtain cookies.',
        );
    }
} finally {
    await Actor.exit();
}

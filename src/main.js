// Startup.jobs scraper (cheap hybrid): Playwright for listing URLs, HTTP+Cheerio for details, Playwright fallback when blocked.
import { Actor, log } from 'apify';
import { Dataset, sleep } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';
import { chromium } from 'playwright';

const ORIGIN = 'https://startup.jobs';
const DEFAULT_LISTING_URL = `${ORIGIN}/remote-jobs?w=remote`;
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: ORIGIN,
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

const tryParseJson = (text) => {
    if (!text || typeof text !== 'string') return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const toAbsoluteUrl = (maybeUrl, baseUrl = ORIGIN) => {
    if (!maybeUrl) return null;
    try {
        return new URL(maybeUrl, baseUrl).href;
    } catch {
        return null;
    }
};

const looksLikeCloudflareChallengeHtml = (html) => {
    if (!html) return false;
    const t = String(html);
    return t.includes('Just a moment...') && t.includes('/cdn-cgi/challenge-platform');
};

const looksLikeCloudflareChallenge = ({ statusCode, headers, bodyText }) => {
    const cfMitigated = String(headers?.['cf-mitigated'] || '').toLowerCase();
    if ((statusCode === 403 || statusCode === 503) && cfMitigated.includes('challenge')) return true;
    return looksLikeCloudflareChallengeHtml(bodyText);
};

const cleanHtmlToText = (html) => {
    if (!html) return null;
    const $ = cheerioLoad(html);
    $('script, style, noscript').remove();
    return $.root().text().replace(/\s+/g, ' ').trim() || null;
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

const extractApplyLinkFromHtml = (html, url) => {
    const $ = cheerioLoad(html);
    const href =
        $('a[href*="/apply"]').first().attr('href') ||
        $('a')
            .filter((_, el) => $(el).text().trim().toLowerCase() === 'apply')
            .first()
            .attr('href') ||
        null;
    return toAbsoluteUrl(href, url) || url;
};

const parseJobDetailFromHtml = (html, url) => {
    const $ = cheerioLoad(html);
    const ld = parseLdJsonJobPosting(html);

    const title = ld?.title || $('h1').first().text().trim() || null;
    const company =
        ld?.hiringOrganization?.name ||
        $('a[href*="/companies/"]').first().text().trim() ||
        $('meta[property="og:site_name"]').attr('content') ||
        null;

    const location =
        ld?.jobLocation?.address?.addressLocality ||
        ld?.jobLocation?.address?.addressRegion ||
        ld?.jobLocation?.address?.addressCountry ||
        $('*[class*="location"]').first().text().trim() ||
        null;

    const descriptionHtml =
        ld?.description ||
        $('main').find('[class*="description"]').first().html() ||
        $('article').first().html() ||
        null;

    const companyLogo =
        toAbsoluteUrl(ld?.hiringOrganization?.logo, ORIGIN) ||
        toAbsoluteUrl($('meta[property="og:image"]').attr('content'), ORIGIN) ||
        null;

    return {
        title,
        company,
        location,
        job_type: normalizeEmploymentType(ld?.employmentType) || null,
        salary: extractSalaryFromLd(ld),
        posted_at: ld?.datePosted || null,
        apply_link: extractApplyLinkFromHtml(html, url),
        description_html: descriptionHtml,
        description_text: cleanHtmlToText(descriptionHtml),
        company_logo: companyLogo,
    };
};

const jobIdFromUrl = (url) => {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/-(\d+)(\/)?$/);
        return m?.[1] || null;
    } catch {
        return null;
    }
};

const normalizeJob = ({ url, detail, source }) => {
    const id = jobIdFromUrl(url) || url;
    return {
        id,
        title: detail?.title || null,
        company: detail?.company || null,
        location: detail?.location || null,
        job_type: detail?.job_type || null,
        salary: detail?.salary || null,
        posted_at: detail?.posted_at || null,
        description_text: detail?.description_text || null,
        description_html: detail?.description_html || null,
        company_logo: detail?.company_logo || null,
        apply_link: detail?.apply_link || url,
        url,
        source,
        fetched_at: new Date().toISOString(),
    };
};

// Startup.jobs job detail URLs are typically slugged and end with "-<id>".
// Example: https://startup.jobs/animal-health-clinical-research-associate-argenta-7566869
const isJobDetailUrl = (url) => {
    try {
        const u = new URL(url);
        if (u.origin !== ORIGIN) return false;
        const p = u.pathname.toLowerCase();
        if (p.startsWith('/cdn-cgi/')) return false;
        if (p.includes('/apply')) return false;
        if (p.startsWith('/company/')) return false;
        if (p.startsWith('/companies/')) return false;
        if (p.startsWith('/tags/')) return false;
        if (p.startsWith('/roles/')) return false;
        if (p.startsWith('/locations/')) return false;
        if (p === '/' || p === '/remote-jobs') return false;
        // Strict: only single-segment paths ending with "-<digits>".
        // This intentionally excludes non-job pages like /company/<slug>.
        return /^\/[^/]+-\d+\/?$/.test(p);
    } catch {
        return false;
    }
};

const proxyUrlToPlaywrightProxy = (proxyUrl) => {
    if (!proxyUrl) return undefined;
    const u = new URL(proxyUrl);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return username || password ? { server, username, password } : { server };
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

    return { context, close };
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

const findNextListingUrl = async (page, currentUrl) => {
    const nextHref = await page
        .$eval('a[rel="next"]', (el) => el.getAttribute('href'))
        .catch(() => null);
    if (nextHref) return toAbsoluteUrl(nextHref, currentUrl);

    const nextByText = await page
        .$$eval('a[href]', (els) => {
            const pick = els.find((el) => (el.textContent || '').trim().toLowerCase() === 'next');
            return pick ? pick.getAttribute('href') : null;
        })
        .catch(() => null);
    if (nextByText) return toAbsoluteUrl(nextByText, currentUrl);

    return null;
};

const withPageParam = (url, pageNumber) => {
    try {
        const u = new URL(url);
        u.searchParams.set('page', String(pageNumber));
        return u.href;
    } catch {
        return url;
    }
};

const fetchJobLinksViaPlaywrightListing = async ({ listingUrl, proxyUrl, limit, maxScrolls, maxPages }) => {
    const { context, close } = await createPlaywrightContext({ proxyUrl });
    const page = await context.newPage();
    try {
        const allUrls = new Set();

        const visitedListingUrls = new Set();
        let currentListingUrl = listingUrl;

        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
            if (visitedListingUrls.has(currentListingUrl)) break;
            visitedListingUrls.add(currentListingUrl);

            log.info(`Playwright listing: opening ${currentListingUrl}`);
            await page.goto(currentListingUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
            await waitForCloudflareClearance(page, { timeoutMs: 60000 });
            await page.waitForTimeout(1500);

            let stableRounds = 0;

            for (let i = 0; i < maxScrolls; i += 1) {
                const before = allUrls.size;

                const html = await page.content().catch(() => '');
                for (const u of parseLdJsonItemListUrls(html, currentListingUrl)) {
                    const abs = toAbsoluteUrl(u, currentListingUrl);
                    if (abs && isJobDetailUrl(abs)) allUrls.add(abs);
                }

                const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')).filter(Boolean));
                for (const href of hrefs) {
                    const abs = toAbsoluteUrl(href, currentListingUrl);
                    if (abs && isJobDetailUrl(abs)) allUrls.add(abs);
                }

                const after = allUrls.size;
                if (after >= limit) return Array.from(allUrls).slice(0, limit);

                if (after === before) stableRounds += 1;
                else stableRounds = 0;

                if (stableRounds >= 3) break;

                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(1200);
            }

            if (allUrls.size >= limit) break;

            const nextUrl = await findNextListingUrl(page, currentListingUrl);
            if (nextUrl) {
                currentListingUrl = nextUrl;
                continue;
            }

            // Fallback pagination: try ?page=N.
            currentListingUrl = withPageParam(listingUrl, pageIndex + 1);
        }

        return Array.from(allUrls).slice(0, limit);
    } finally {
        await page.close().catch(() => {});
        await close();
    }
};

const fetchDetailViaHttp = async ({ url, proxyUrl }) => {
    const res = await gotScraping({
        url,
        headers: { ...DEFAULT_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: ORIGIN },
        proxyUrl,
        timeout: { request: 45000 },
        throwHttpErrors: false,
        responseType: 'text',
        followRedirect: true,
        retry: { limit: 0 },
    });

    if (looksLikeCloudflareChallenge({ statusCode: res.statusCode, headers: res.headers, bodyText: res.body })) {
        const err = new Error(`Cloudflare challenge (${res.statusCode})`);
        err.isCloudflare = true;
        throw err;
    }

    if (res.statusCode !== 200) return null;
    return parseJobDetailFromHtml(res.body, url);
};

const fetchDetailViaPlaywright = async ({ context, url }) => {
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

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrl,
        keyword = '',
        location = 'Remote',
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
        listingUrlsFound: 0,
        httpDetailsOk: 0,
        httpDetailsBlocked: 0,
        playwrightDetails: 0,
        errors: 0,
        runtimeSeconds: 0,
    };

    const linkLimit = Math.min(500, resultsWanted * 4);
    const maxScrolls = Math.min(40, maxPages * 10);

    const urls = await fetchJobLinksViaPlaywrightListing({
        listingUrl,
        proxyUrl,
        limit: linkLimit,
        maxScrolls,
        maxPages,
    });
    stats.listingUrlsFound = urls.length;
    log.info(`Listing extracted: ${urls.length} job URLs`);

    const seen = new Set();
    const httpLimiter = createLimiter(maxConcurrency);
    const pwLimiter = createLimiter(Math.min(2, maxConcurrency));

    let pwContext = null;
    let pwClose = null;
    const ensurePw = async () => {
        if (pwContext) return;
        const { context, close } = await createPlaywrightContext({ proxyUrl });
        pwContext = context;
        pwClose = close;
    };

    let disableHttpDetails = false;
    const firstWindow = { attempts: 0, ok: 0, blocked: 0 };

    const processOne = async (url) => {
        if (stats.jobsSaved >= resultsWanted) return;
        if (seen.has(url)) return;
        seen.add(url);

        try {
            let detail = null;
            let source = 'http';

            if (!disableHttpDetails) {
                firstWindow.attempts += 1;
                try {
                    detail = await fetchDetailViaHttp({ url, proxyUrl });
                    if (detail) {
                        stats.httpDetailsOk += 1;
                        firstWindow.ok += 1;
                    }
                } catch (err) {
                    if (err?.isCloudflare) {
                        stats.httpDetailsBlocked += 1;
                        firstWindow.blocked += 1;
                    } else {
                        throw err;
                    }
                }

                if (firstWindow.attempts >= 6 && firstWindow.ok === 0 && firstWindow.blocked >= 5) {
                    disableHttpDetails = true;
                    log.warning('HTTP detail requests appear fully Cloudflare-blocked; switching remaining details to Playwright for speed.');
                }
            }

            if (!detail) {
                await ensurePw();
                source = 'playwright';
                stats.playwrightDetails += 1;
                detail = await pwLimiter(() => fetchDetailViaPlaywright({ context: pwContext, url }));
            }

            if (!detail?.title && !detail?.company) {
                // Still push minimal record so users can retry/inspect.
                source = `${source}-minimal`;
            }

            const job = normalizeJob({ url, detail, source });
            await Dataset.pushData(job);
            stats.jobsSaved += 1;
        } catch (err) {
            stats.errors += 1;
            log.warning(`Failed ${url}: ${err.message}`);
        }
    };

    const tasks = urls.slice(0, linkLimit).map((url) =>
        httpLimiter(async () => {
            await processOne(url);
        }),
    );

    await Promise.all(tasks);

    stats.runtimeSeconds = (Date.now() - startTime) / 1000;
    await Actor.setValue('OUTPUT_SUMMARY', { ...stats, listingUrl, resultsWanted });

    log.info('='.repeat(60));
    log.info('STARTUP.JOBS SCRAPER SUMMARY');
    log.info('='.repeat(60));
    log.info(`Jobs saved: ${stats.jobsSaved}/${resultsWanted}`);
    log.info(`Listing URLs found: ${stats.listingUrlsFound}`);
    log.info(`HTTP details OK: ${stats.httpDetailsOk}`);
    log.info(`HTTP details blocked: ${stats.httpDetailsBlocked}`);
    log.info(`Playwright details used: ${stats.playwrightDetails}`);
    log.info(`Errors: ${stats.errors}`);
    log.info(`Runtime: ${stats.runtimeSeconds.toFixed(2)}s`);
    log.info('='.repeat(60));

    if (pwClose) await pwClose();

    if (stats.jobsSaved === 0) {
        await Actor.setValue('NO_RESULTS', true);
        log.warning('No jobs were scraped. Try Apify Proxy (RESIDENTIAL) and set maxConcurrency=1-2.');
    }
} finally {
    await Actor.exit();
}

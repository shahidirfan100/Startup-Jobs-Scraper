import { Actor, log } from 'apify';
import { load as cheerioLoad } from 'cheerio';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { firefox } from 'playwright';

const ORIGIN = 'https://startup.jobs';
const DEFAULT_LISTING_URL = `${ORIGIN}/remote-jobs?w=remote`;
const MAX_ALGOLIA_HITS_PER_PAGE = 100;
const DATASET_BATCH_SIZE = 10;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

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

const createDatasetBatchPusher = ({ batchSize = DATASET_BATCH_SIZE } = {}) => {
    const buffer = [];
    let pushedCount = 0;
    let chain = Promise.resolve();

    const schedulePush = (items) => {
        if (!items.length) return;
        chain = chain.then(async () => {
            await Dataset.pushData(items);
            pushedCount += items.length;
            log.info(`Dataset batch pushed: ${items.length} items (total pushed: ${pushedCount})`);
        });
    };

    const add = (item) => {
        buffer.push(item);
        if (buffer.length >= batchSize) {
            const chunk = buffer.splice(0, batchSize);
            schedulePush(chunk);
        }
    };

    const flush = async () => {
        if (buffer.length > 0) {
            const remaining = buffer.splice(0, buffer.length);
            await schedulePush(remaining);
        }
        await chain;
        return pushedCount;
    };

    const getBufferedCount = () => buffer.length;
    const getPushedCount = () => pushedCount;

    return { add, flush, getBufferedCount, getPushedCount };
};

const toAbsoluteUrl = (maybeUrl, base = ORIGIN) => {
    if (!maybeUrl) return null;
    try {
        return new URL(maybeUrl, base).href;
    } catch {
        return null;
    }
};

const tryParseJson = (value) => {
    if (!value || typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const looksLikeCloudflareChallengeHtml = (html) => {
    if (!html) return false;
    const text = String(html);
    const hasTitle = text.includes('Just a moment...');
    const hasChallengePath = text.includes('/cdn-cgi/challenge-platform');
    const hasAlgoliaMeta = text.includes('current-algolia-application-id');
    return hasTitle || (hasChallengePath && !hasAlgoliaMeta);
};

const normalizeEmploymentType = (value) => {
    if (!value) return null;
    return String(value)
        .replace(/[_-]/g, ' ')
        .trim()
        .split(/\s+/)
        .map((token) => token[0].toUpperCase() + token.slice(1).toLowerCase())
        .join(' ');
};

const formatSalaryRange = ({ min, max, currency }) => {
    if (min == null && max == null) return null;
    const c = currency || 'USD';
    if (min != null && max != null) return `${c} ${min} - ${max}`;
    if (min != null) return `${c} ${min}+`;
    return `${c} <=${max}`;
};

const buildListingUrl = ({ startUrl, keyword, location }) => {
    if (startUrl) return startUrl;
    const url = new URL(DEFAULT_LISTING_URL);
    const q = String(keyword || '').trim();
    if (q) url.searchParams.set('q', q);

    const w = String(location || '').trim().toLowerCase();
    if (!w || w === 'remote') {
        url.searchParams.set('w', 'remote');
    }
    return url.href;
};

const parseSearchInputsFromListingUrl = (listingUrl, keyword, location) => {
    const result = {
        query: String(keyword || '').trim(),
        workplaceTypes: [],
        employmentTypes: [],
        since: '',
        experienceBucket: '',
    };

    try {
        const u = new URL(listingUrl);
        const urlQuery = String(u.searchParams.get('q') || '').trim();
        if (!result.query && urlQuery) result.query = urlQuery;

        result.workplaceTypes = u.searchParams
            .getAll('w')
            .flatMap((v) => String(v).split(','))
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean);

        result.employmentTypes = u.searchParams
            .getAll('c')
            .flatMap((v) => String(v).split(','))
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean);

        result.since = String(u.searchParams.get('since') || '').trim().toLowerCase();
        result.experienceBucket = String(u.searchParams.get('exp') || '').trim().toLowerCase();
    } catch {
        // Ignore malformed URL; use direct input fields only.
    }

    const normalizedLocation = String(location || '').trim().toLowerCase();
    if (result.workplaceTypes.length === 0 && normalizedLocation === 'remote') {
        result.workplaceTypes = ['remote'];
    }

    return result;
};

const sinceToUnixSeconds = (since) => {
    const now = Date.now();
    if (since === '24h') return Math.floor((now - 24 * 60 * 60 * 1000) / 1000);
    if (since === '7d') return Math.floor((now - 7 * 24 * 60 * 60 * 1000) / 1000);
    if (since === '30d') return Math.floor((now - 30 * 24 * 60 * 60 * 1000) / 1000);
    return null;
};

const buildAlgoliaPayload = ({ query, workplaceTypes, employmentTypes, since, experienceBucket, page }) => {
    const facetFilters = [];

    if (employmentTypes.length > 0) {
        facetFilters.push(employmentTypes.map((item) => `employment_type:${item}`));
    }

    if (workplaceTypes.length > 0) {
        facetFilters.push(workplaceTypes.map((item) => `workplace_type_id:${item}`));
    }

    if (experienceBucket) {
        facetFilters.push([`experience_bucket:${experienceBucket}`]);
    }

    const filters = [];
    const sinceTs = sinceToUnixSeconds(since);
    if (sinceTs) filters.push(`published_at_i >= ${sinceTs}`);

    return {
        query,
        page,
        hitsPerPage: MAX_ALGOLIA_HITS_PER_PAGE,
        attributesToRetrieve: ['*'],
        facets: ['employment_type', 'workplace_type_id'],
        facetFilters,
        filters: filters.join(' AND '),
        analyticsTags: ['apify-actor'],
    };
};

const createPlaywrightContext = async () => {
    const browser = await firefox.launch({
        headless: true,
    });

    const context = await browser.newContext({
        userAgent: getRandomUserAgent(),
        locale: 'en-US',
        timezoneId: 'UTC',
        viewport: { width: 1365, height: 768 },
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: ORIGIN,
        },
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        window.chrome = window.chrome || { runtime: {} };
    });

    await context.route('**/*', async (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        if (
            ['image', 'font', 'media', 'stylesheet'].includes(type) ||
            url.includes('googletagmanager') ||
            url.includes('google-analytics') ||
            url.includes('doubleclick') ||
            url.includes('facebook')
        ) {
            return route.abort();
        }
        return route.continue();
    });

    const close = async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    };

    return { context, close };
};

const waitForCloudflareClearance = async (page, timeoutMs = 15000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const html = await page.content().catch(() => '');
        if (!looksLikeCloudflareChallengeHtml(html)) return true;
        await page.waitForTimeout(1000);
    }
    return false;
};

const bootstrapListingAndAlgoliaConfig = async ({ page, listingUrl }) => {
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForCloudflareClearance(page, 15000);
    await page.waitForSelector('body', { timeout: 12000 });

    const data = await page.evaluate(() => {
        const readMeta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || null;
        return {
            appId: readMeta('current-algolia-application-id'),
            apiKey: readMeta('current-algolia-api-key-search'),
            indexName: readMeta('current-algolia-index-post'),
        };
    });

    if (!data.appId || !data.apiKey || !data.indexName) {
        throw new Error('Failed to load Algolia config from listing page');
    }

    return data;
};

const fetchAlgoliaPageViaPlaywright = async ({ page, config, payload }) =>
    page.evaluate(
        async ({ appId, apiKey, indexName, queryPayload }) => {
            const endpoint = `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-algolia-api-key': apiKey,
                    'x-algolia-application-id': appId,
                },
                body: JSON.stringify(queryPayload),
            });

            const responseText = await response.text();
            let json;
            try {
                json = JSON.parse(responseText);
            } catch {
                json = null;
            }

            return {
                status: response.status,
                json,
                textSnippet: responseText.slice(0, 500),
            };
        },
        {
            appId: config.appId,
            apiKey: config.apiKey,
            indexName: config.indexName,
            queryPayload: payload,
        },
    );

const decodeHtmlEntities = (value) =>
    String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');

const cleanHtmlToText = (html) => {
    if (!html) return null;
    const stripped = String(html)
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return decodeHtmlEntities(stripped) || null;
};

const extractJobPostingJsonLd = (html) => {
    const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    const matches = html.matchAll(scriptRegex);
    for (const match of matches) {
        const parsed = tryParseJson(match[1].trim());
        if (!parsed) continue;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
            if (entry && typeof entry === 'object' && entry['@type'] === 'JobPosting') {
                return entry;
            }
        }
    }
    return null;
};

const resolveLocation = ({ hit, jobPosting, locationHint }) => {
    const locationType = String(jobPosting?.jobLocationType || '').toLowerCase();
    if (locationType.includes('telecommute')) return 'Remote';

    const applicant = String(jobPosting?.applicantLocationRequirements?.name || '').toLowerCase();
    if (applicant.includes('anywhere') || applicant.includes('remote')) return 'Remote';

    let places = [];
    if (Array.isArray(jobPosting?.jobLocation)) {
        places = jobPosting.jobLocation;
    } else if (jobPosting?.jobLocation) {
        places = [jobPosting.jobLocation];
    }

    for (const place of places) {
        const locality = place?.address?.addressLocality;
        const region = place?.address?.addressRegion;
        const country = place?.address?.addressCountry;
        const resolved = [locality, region, country].find((value) => typeof value === 'string' && value.trim());
        if (resolved) return resolved.trim();
    }

    if (String(hit?.workplace_type_id || '').toLowerCase() === 'remote') return 'Remote';
    if (hit?.location && String(hit.location).trim()) return String(hit.location).trim();
    if (locationHint && String(locationHint).trim()) return String(locationHint).trim();
    return null;
};

const extractApplyLink = (html, jobUrl) => {
    const directMatch = html.match(/href=["'](\/apply\/[^"']+)["']/i);
    if (directMatch?.[1]) return toAbsoluteUrl(directMatch[1], jobUrl) || jobUrl;

    const $ = cheerioLoad(html);
    const href =
        $('a[href^="/apply/"]').first().attr('href') ||
        $('a[rel="nofollow"][href*="/apply"]').first().attr('href') ||
        $('a')
            .filter((_, el) => $(el).text().trim().toLowerCase() === 'apply')
            .first()
            .attr('href') ||
        null;

    return toAbsoluteUrl(href, jobUrl) || jobUrl;
};

const extractOgImage = (html) => {
    const m = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    return m?.[1] ? decodeHtmlEntities(m[1]) : null;
};

const salaryFromJsonLd = (jobPosting) => {
    const baseSalary = jobPosting?.baseSalary;
    if (!baseSalary) return null;

    const currency = baseSalary?.currency || null;
    const min = baseSalary?.value?.minValue ?? null;
    const max = baseSalary?.value?.maxValue ?? null;
    const scalar = baseSalary?.value?.value ?? baseSalary?.value;

    if (min != null || max != null) return formatSalaryRange({ min, max, currency });
    if (typeof scalar === 'number') return formatSalaryRange({ min: scalar, max: null, currency });
    if (typeof scalar === 'string') return scalar;
    return null;
};

const parseDetailFromHtml = ({ html, url, hit, locationHint }) => {
    const jobPosting = extractJobPostingJsonLd(html);
    let descriptionHtml = jobPosting?.description || null;
    let companyLogoFromHtml = null;

    if (!descriptionHtml || !jobPosting?.hiringOrganization?.logo) {
        const $ = cheerioLoad(html);
        if (!descriptionHtml) {
            descriptionHtml =
                $('[class*="trix-content"]').first().html() ||
                $('article').first().html() ||
                null;
        }
        companyLogoFromHtml = $('meta[property="og:image"]').attr('content') || null;
    }

    const salaryFromListing = formatSalaryRange({
        min: hit.salary_min,
        max: hit.salary_max,
        currency: hit.salary_currency || 'USD',
    });

    return {
        title: jobPosting?.title || hit.title || null,
        company: jobPosting?.hiringOrganization?.name || hit.company_name || null,
        location: resolveLocation({ hit, jobPosting, locationHint }),
        job_type: normalizeEmploymentType(jobPosting?.employmentType || hit.employment_type_id || hit.employment_type),
        salary: salaryFromJsonLd(jobPosting) || salaryFromListing,
        posted_at: jobPosting?.datePosted || hit.published_at_iso8601 || null,
        description_html: descriptionHtml || null,
        description_text: cleanHtmlToText(descriptionHtml || ''),
        company_logo:
            toAbsoluteUrl(jobPosting?.hiringOrganization?.logo, ORIGIN) ||
            toAbsoluteUrl(hit.company_logo_url, ORIGIN) ||
            toAbsoluteUrl(companyLogoFromHtml || extractOgImage(html), ORIGIN) ||
            null,
        apply_link: extractApplyLink(html, url),
    };
};

const fetchDetailViaHttp = async ({ url, hit, locationHint }) => {
    const response = await gotScraping({
        url,
        headers: {
            'user-agent': getRandomUserAgent(),
            'accept-language': 'en-US,en;q=0.9',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            referer: ORIGIN,
        },
        throwHttpErrors: false,
        timeout: { request: 15000 },
        responseType: 'text',
        followRedirect: true,
        retry: { limit: 0 },
    });

    if (response.statusCode !== 200) return null;
    if (looksLikeCloudflareChallengeHtml(response.body)) {
        const error = new Error('Cloudflare challenge on detail page');
        error.isBlocked = true;
        throw error;
    }

    return parseDetailFromHtml({
        html: response.body,
        url,
        hit,
        locationHint,
    });
};

const fetchDetailViaPlaywright = async ({ context, url, hit, locationHint }) => {
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflareClearance(page, 10000);
        const html = await page.content();
        return parseDetailFromHtml({
            html,
            url,
            hit,
            locationHint,
        });
    } finally {
        await page.close().catch(() => {});
    }
};

const normalizeOutputJob = ({ hit, detail }) => {
    const url = toAbsoluteUrl(hit.path, ORIGIN);
    // eslint-disable-next-line no-underscore-dangle
    const tags = Array.isArray(hit._tags) ? hit._tags : [];

    const fallbackSalary = formatSalaryRange({
        min: hit.salary_min,
        max: hit.salary_max,
        currency: hit.salary_currency || 'USD',
    });

    return {
        id: hit.objectID || null,
        title: detail?.title || hit.title || null,
        company: detail?.company || hit.company_name || null,
        location: detail?.location || (String(hit.workplace_type_id || '').toLowerCase() === 'remote' ? 'Remote' : hit.location || null),
        job_type: detail?.job_type || normalizeEmploymentType(hit.employment_type_id || hit.employment_type),
        salary: detail?.salary || fallbackSalary,
        posted_at: detail?.posted_at || hit.published_at_iso8601 || null,
        description_text: detail?.description_text || null,
        description_html: detail?.description_html || null,
        company_logo: detail?.company_logo || toAbsoluteUrl(hit.company_logo_url, ORIGIN),
        apply_link: detail?.apply_link || url,
        url,
        source: detail ? detail.source || 'algolia+jsonld' : 'algolia-only',
        fetched_at: new Date().toISOString(),

        tags,
        workplace_type: hit.workplace_type_id || null,
        employment_type: hit.employment_type_id || hit.employment_type || null,
        experience_bucket: hit.experience_bucket || null,
        salary_min: hit.salary_min ?? null,
        salary_max: hit.salary_max ?? null,
        salary_currency: hit.salary_currency || null,
        city: hit.city || null,
        country: hit.country || null,
        company_slug: hit.company_slug || null,
    };
};

await Actor.init();

let recoveryHits = [];
let outputAlreadyPushed = false;
let runStats = null;
let batchPusherForRecovery = null;

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrl,
        keyword = '',
        location = 'Remote',
        collectDetails = true,
        results_wanted: resultsWantedRaw = 20,
        max_pages: maxPagesRaw = 3,
        maxConcurrency: maxConcurrencyRaw = 2,
    } = input;

    const resultsWanted = Math.min(500, Math.max(1, Number(resultsWantedRaw) || 1));
    const maxPages = Math.max(1, Number(maxPagesRaw) || 1);
    const maxConcurrency = Math.max(1, Number(maxConcurrencyRaw) || 1);

    const listingUrl = buildListingUrl({ startUrl, keyword, location });
    const searchParams = parseSearchInputsFromListingUrl(listingUrl, keyword, location);
    const locationHint = String(location || '').trim() || null;

    log.info('Proxy is disabled by configuration for maximum speed and stability.');

    const stats = {
        listingUrl,
        query: searchParams.query,
        jobsSaved: 0,
        algoliaHitsCollected: 0,
        algoliaReportedHits: 0,
        algoliaReportedPages: 0,
        algoliaFieldCount: 0,
        detailHttpOk: 0,
        detailPlaywrightOk: 0,
        detailFailed: 0,
        errors: 0,
        runtimeSeconds: 0,
    };
    runStats = stats;

    const startTime = Date.now();
    const { context, close } = await createPlaywrightContext();
    try {
        const listingPage = await context.newPage();
        const algoliaConfig = await bootstrapListingAndAlgoliaConfig({
            page: listingPage,
            listingUrl,
        });
        log.info(
            `Using internal API (via Playwright): https://${algoliaConfig.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${algoliaConfig.indexName}/query`,
        );

        const collected = new Map();
        const allFieldNames = new Set();

        for (let page = 0; page < maxPages && collected.size < resultsWanted; page += 1) {
            const payload = buildAlgoliaPayload({
                ...searchParams,
                page,
            });

            const algoliaResponse = await fetchAlgoliaPageViaPlaywright({
                page: listingPage,
                config: algoliaConfig,
                payload,
            });

            if (algoliaResponse.status !== 200 || !algoliaResponse.json) {
                throw new Error(
                    `Algolia Playwright request failed (${algoliaResponse.status}): ${algoliaResponse.textSnippet}`,
                );
            }

            const responseJson = algoliaResponse.json;
            const hits = Array.isArray(responseJson.hits) ? responseJson.hits : [];
            const nbPages = Number(responseJson.nbPages || 0);
            const nbHits = Number(responseJson.nbHits || 0);

            if (nbHits > 0) stats.algoliaReportedHits = nbHits;
            if (nbPages > 0) stats.algoliaReportedPages = nbPages;

            log.info(`Algolia page ${page + 1}: ${hits.length} hits`);

            for (const hit of hits) {
                for (const key of Object.keys(hit || {})) allFieldNames.add(key);
                if (!hit?.objectID || !hit?.path) continue;
                if (!collected.has(hit.objectID)) collected.set(hit.objectID, hit);
                if (collected.size >= resultsWanted) break;
            }

            if (hits.length === 0) break;
            if (nbPages > 0 && page + 1 >= nbPages) break;
        }

        await listingPage.close().catch(() => {});

        const hits = Array.from(collected.values()).slice(0, resultsWanted);
        recoveryHits = hits;
        stats.algoliaHitsCollected = hits.length;
        stats.algoliaFieldCount = allFieldNames.size;

        const httpConcurrency = collectDetails ? Math.min(12, Math.max(4, maxConcurrency * 4)) : maxConcurrency;
        const httpLimiter = createLimiter(httpConcurrency);
        const browserLimiter = createLimiter(maxConcurrency);
        const batchPusher = createDatasetBatchPusher({ batchSize: DATASET_BATCH_SIZE });
        batchPusherForRecovery = batchPusher;

        const settled = await Promise.allSettled(
            hits.map((hit) =>
                httpLimiter(async () => {
                    const url = toAbsoluteUrl(hit.path, ORIGIN);
                    let detail = null;

                    if (collectDetails && url) {
                        try {
                            detail = await fetchDetailViaHttp({
                                url,
                                hit,
                                locationHint,
                            });
                            if (detail) {
                                detail.source = 'algolia+http-jsonld';
                                stats.detailHttpOk += 1;
                            }
                        } catch (error) {
                            if (!error?.isBlocked) {
                                log.warning(`HTTP detail failed for ${url}: ${error.message}`);
                            }
                        }

                        if (!detail) {
                            try {
                                detail = await browserLimiter(() =>
                                    fetchDetailViaPlaywright({
                                        context,
                                        url,
                                        hit,
                                        locationHint,
                                    }),
                                );
                                if (detail) {
                                    detail.source = 'algolia+playwright-jsonld';
                                    stats.detailPlaywrightOk += 1;
                                } else {
                                    stats.detailFailed += 1;
                                }
                            } catch (error) {
                                stats.detailFailed += 1;
                                stats.errors += 1;
                                log.warning(`Playwright detail failed for ${url}: ${error.message}`);
                            }
                        }
                    }

                    const outputItem = normalizeOutputJob({
                        hit,
                        detail,
                    });

                    batchPusher.add(outputItem);
                    stats.jobsSaved += 1;
                }),
            ),
        );

        for (const result of settled) {
            if (result.status === 'rejected') {
                stats.errors += 1;
                log.warning(`Job task crashed: ${result.reason?.message || result.reason}`);
            }
        }

        const totalPushed = await batchPusher.flush();
        if (totalPushed > 0) outputAlreadyPushed = true;
        stats.jobsSaved = Math.max(stats.jobsSaved, totalPushed);
        batchPusherForRecovery = null;
    } finally {
        await close();
    }

    stats.runtimeSeconds = (Date.now() - startTime) / 1000;
    await Actor.setValue('OUTPUT_SUMMARY', stats);

    log.info('='.repeat(60));
    log.info('STARTUP.JOBS SCRAPER SUMMARY');
    log.info('='.repeat(60));
    log.info(`Listing URL: ${stats.listingUrl}`);
    log.info(`Query: ${stats.query || '(empty)'}`);
    log.info(`Jobs saved: ${stats.jobsSaved}/${resultsWanted}`);
    log.info(`Algolia hits collected: ${stats.algoliaHitsCollected}`);
    log.info(`Algolia fields seen: ${stats.algoliaFieldCount}`);
    log.info(`Algolia reported hits/pages: ${stats.algoliaReportedHits}/${stats.algoliaReportedPages}`);
    log.info(`Detail via HTTP JSON-LD: ${stats.detailHttpOk}`);
    log.info(`Detail via Playwright fallback: ${stats.detailPlaywrightOk}`);
    log.info(`Detail failures: ${stats.detailFailed}`);
    log.info(`Errors: ${stats.errors}`);
    log.info(`Runtime: ${stats.runtimeSeconds.toFixed(2)}s`);
    log.info('='.repeat(60));

    if (stats.algoliaReportedHits > 500 && stats.algoliaReportedPages <= 5) {
        log.warning('Algolia query appears capped by paginationLimitedTo=500 for this search context.');
    }

    if (stats.jobsSaved === 0) {
        await Actor.setValue('NO_RESULTS', true);
        log.warning('No jobs were scraped.');
    }
} catch (error) {
    log.error(`Run failed: ${error.message}`);

    if (batchPusherForRecovery) {
        try {
            const flushed = await batchPusherForRecovery.flush();
            if (flushed > 0) {
                outputAlreadyPushed = true;
                if (runStats) {
                    runStats.jobsSaved = Math.max(runStats.jobsSaved || 0, flushed);
                }
            }
        } catch (flushError) {
            log.error(`Buffered batch flush failed during recovery: ${flushError.message}`);
        } finally {
            batchPusherForRecovery = null;
        }
    }

    if (!outputAlreadyPushed && recoveryHits.length > 0) {
        try {
            const fallbackItems = recoveryHits.map((hit) =>
                normalizeOutputJob({
                    hit,
                    detail: null,
                }),
            );
            await Dataset.pushData(fallbackItems);
            outputAlreadyPushed = true;
            if (runStats) {
                runStats.jobsSaved = fallbackItems.length;
                runStats.errors += 1;
                runStats.runtimeSeconds = runStats.runtimeSeconds || 0;
                runStats.recovered = true;
                await Actor.setValue('OUTPUT_SUMMARY', runStats);
            }
            log.warning('Recovered by saving listing-only output after runtime failure.');
        } catch (recoveryError) {
            log.error(`Recovery output failed: ${recoveryError.message}`);
        }
    }

    await Actor.setValue('LAST_ERROR', {
        message: error.message,
        stack: error.stack,
        failed_at: new Date().toISOString(),
    });
} finally {
    await Actor.exit();
}

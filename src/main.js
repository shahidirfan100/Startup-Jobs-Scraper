import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

const ORIGIN = 'https://startup.jobs';
const DEFAULT_LISTING_URL = `${ORIGIN}/remote-jobs?w=remote`;
const MAX_ALGOLIA_HITS_PER_PAGE = 100;
const DATASET_BATCH_SIZE = 10;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const createDatasetBatchPusher = ({ batchSize = DATASET_BATCH_SIZE } = {}) => {
    const buffer = [];
    let pushedCount = 0;
    let chain = Promise.resolve();

    const schedulePush = (items) => {
        if (!items.length) return;
        chain = chain.then(async () => {
            await Actor.pushData(items);
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

const extractMetaContent = (html, name) => {
    if (!html) return null;
    const patterns = [
        new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, 'i'),
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
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

const fetchListingHtml = async (listingUrl) => {
    const response = await gotScraping({
        url: listingUrl,
        headers: {
            'user-agent': getRandomUserAgent(),
            'accept-language': 'en-US,en;q=0.9',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            referer: ORIGIN,
        },
        useHeaderGenerator: false,
        throwHttpErrors: false,
        timeout: { request: 30000 },
        responseType: 'text',
        followRedirect: true,
        retry: { limit: 1 },
    });

    if (response.statusCode !== 200) {
        throw new Error(`Listing bootstrap failed with HTTP ${response.statusCode}`);
    }
    if (looksLikeCloudflareChallengeHtml(response.body)) {
        throw new Error('Listing bootstrap returned a Cloudflare challenge');
    }

    return response.body;
};

const bootstrapListingAndAlgoliaConfig = async ({ listingUrl }) => {
    const html = await fetchListingHtml(listingUrl);
    const data = {
        appId: extractMetaContent(html, 'current-algolia-application-id'),
        apiKey: extractMetaContent(html, 'current-algolia-api-key-search'),
        indexName: extractMetaContent(html, 'current-algolia-index-post'),
    };

    if (!data.appId || !data.apiKey || !data.indexName) {
        throw new Error('Failed to load Algolia config from listing page HTML');
    }

    return data;
};

const fetchAlgoliaPageViaHttp = async ({ config, payload, referer }) => {
    const endpoint = `https://${config.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(config.indexName)}/query`;
    const response = await gotScraping.post(endpoint, {
        json: payload,
        headers: {
            'content-type': 'application/json',
            'x-algolia-api-key': config.apiKey,
            'x-algolia-application-id': config.appId,
            origin: ORIGIN,
            referer,
        },
        useHeaderGenerator: false,
        throwHttpErrors: false,
        timeout: { request: 30000 },
        retry: { limit: 2 },
    });

    const responseText = response.body;
    const json = tryParseJson(responseText);

    return {
        status: response.statusCode,
        json,
        textSnippet: String(responseText || '').slice(0, 500),
    };
};

const normalizeOutputJob = ({ hit }) => {
    const url = toAbsoluteUrl(hit.path, ORIGIN);
    // eslint-disable-next-line no-underscore-dangle
    const tags = Array.isArray(hit._tags) ? hit._tags : [];
    // eslint-disable-next-line no-underscore-dangle
    const geoloc = hit._geoloc && typeof hit._geoloc === 'object' ? hit._geoloc : {};

    const fallbackSalary = formatSalaryRange({
        min: hit.salary_min,
        max: hit.salary_max,
        currency: hit.salary_currency || 'USD',
    });

    return {
        id: hit.objectID || null,
        title: hit.title || null,
        company: hit.company_name || null,
        location: String(hit.workplace_type_id || '').toLowerCase() === 'remote' ? 'Remote' : hit.location || null,
        job_type: normalizeEmploymentType(hit.employment_type_id || hit.employment_type),
        salary: fallbackSalary,
        posted_at: hit.published_at_iso8601 || null,
        company_logo: toAbsoluteUrl(hit.company_logo_url, ORIGIN),
        apply_link: url,
        url,
        source: 'listing-api',
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
        country_code: hit.country_code || null,
        country_id: hit.country_id ?? null,
        city_id: hit.city_id ?? null,
        state_id: hit.state_id ?? null,
        company_id: hit.company_id ?? null,
        company_slug: hit.company_slug || null,
        role_ids: Array.isArray(hit.role_ids) ? hit.role_ids : null,
        location_parts: Array.isArray(hit.location_parts) ? hit.location_parts : null,
        published_at_unix: hit.published_at_i ?? null,
        created_at_unix: hit.created_at_i ?? null,
        has_salary: hit.has_salary ?? null,
        salary_interval: hit.salary_interval || null,
        salary_min_usd: hit.salary_min_usd ?? null,
        salary_max_usd: hit.salary_max_usd ?? null,
        geo_lat: geoloc.lat ?? null,
        geo_lng: geoloc.lng ?? null,
        highlighted: hit.highlighted ?? null,
    };
};

const pruneEmptyValues = (record) =>
    Object.fromEntries(
        Object.entries(record).filter(([, value]) => {
            if (value === null || value === undefined || value === '') return false;
            if (Array.isArray(value) && value.length === 0) return false;
            return true;
        }),
    );

const withMissingFieldReport = (record, requiredFields) => {
    const missingFields = requiredFields.filter((field) => {
        const value = record[field];
        return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    });
    const cleaned = pruneEmptyValues(record);
    if (missingFields.length > 0) cleaned.missing_fields = missingFields;
    return cleaned;
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
        results_wanted: resultsWantedRaw = 20,
        max_pages: maxPagesRaw = 3,
    } = input;

    const resultsWanted = Math.min(500, Math.max(1, Number(resultsWantedRaw) || 1));
    const maxPages = Math.max(1, Number(maxPagesRaw) || 1);

    const listingUrl = buildListingUrl({ startUrl, keyword, location });
    const searchParams = parseSearchInputsFromListingUrl(listingUrl, keyword, location);

    log.info('Proxy is disabled by configuration for maximum speed and stability.');

    const stats = {
        listingUrl,
        query: searchParams.query,
        jobsSaved: 0,
        algoliaHitsCollected: 0,
        algoliaReportedHits: 0,
        algoliaReportedPages: 0,
        algoliaFieldCount: 0,
        duplicateHitsSkipped: 0,
        recordsWithMissingFields: 0,
        errors: 0,
        runtimeSeconds: 0,
    };
    runStats = stats;

    const startTime = Date.now();
    {
        const algoliaConfig = await bootstrapListingAndAlgoliaConfig({
            listingUrl,
        });
        log.info(
            `Using internal API via HTTP: https://${algoliaConfig.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${algoliaConfig.indexName}/query`,
        );

        const collected = new Map();
        const allFieldNames = new Set();

        for (let page = 0; page < maxPages && collected.size < resultsWanted; page += 1) {
            const payload = buildAlgoliaPayload({
                ...searchParams,
                page,
            });

            const algoliaResponse = await fetchAlgoliaPageViaHttp({
                config: algoliaConfig,
                payload,
                referer: listingUrl,
            });

            if (algoliaResponse.status !== 200 || !algoliaResponse.json) {
                throw new Error(
                    `Algolia HTTP request failed (${algoliaResponse.status}): ${algoliaResponse.textSnippet}`,
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
                if (collected.has(hit.objectID)) {
                    stats.duplicateHitsSkipped += 1;
                } else {
                    collected.set(hit.objectID, hit);
                }
                if (collected.size >= resultsWanted) break;
            }

            if (hits.length === 0) break;
            if (nbPages > 0 && page + 1 >= nbPages) break;
        }

        const hits = Array.from(collected.values()).slice(0, resultsWanted);
        recoveryHits = hits;
        stats.algoliaHitsCollected = hits.length;
        stats.algoliaFieldCount = allFieldNames.size;

        const batchPusher = createDatasetBatchPusher({ batchSize: DATASET_BATCH_SIZE });
        batchPusherForRecovery = batchPusher;
        const requiredOutputFields = ['id', 'title', 'company', 'location', 'posted_at', 'url', 'apply_link'];

        for (const hit of hits) {
            const rawOutputItem = normalizeOutputJob({ hit });
            const outputItem = withMissingFieldReport(rawOutputItem, requiredOutputFields);
            if (outputItem.missing_fields) stats.recordsWithMissingFields += 1;

            batchPusher.add(outputItem);
            stats.jobsSaved += 1;
        }

        const totalPushed = await batchPusher.flush();
        if (totalPushed > 0) outputAlreadyPushed = true;
        stats.jobsSaved = Math.max(stats.jobsSaved, totalPushed);
        batchPusherForRecovery = null;
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
    log.info(`Duplicate hits skipped: ${stats.duplicateHitsSkipped}`);
    log.info(`Records with missing core fields: ${stats.recordsWithMissingFields}`);
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
                withMissingFieldReport(
                    normalizeOutputJob({
                        hit,
                    }),
                    ['id', 'title', 'company', 'location', 'posted_at', 'url', 'apply_link'],
                ),
            );
            await Actor.pushData(fallbackItems);
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

## Selected API

- Endpoint: `https://4cqmtmmk73-dsn.algolia.net/1/indexes/Post_production/query`
- Method: `POST`
- Auth: Public Algolia search key from Startup.jobs listing page meta tags.
- Pagination: `page` and `hitsPerPage` in the JSON body. Tested with `hitsPerPage: 20`; actor uses up to 100 per page.
- Works with plain `gotScraping`: Yes.
- HTTP/2 required: No.
- Proxy required: No.
- Headers required: `content-type`, `x-algolia-api-key`, `x-algolia-application-id`, `origin`, `referer`.
- Browser required: No.

## Fields Available

Algolia listing hits expose 34 fields:

`_geoloc`, `_highlightResult`, `_tags`, `city`, `city_id`, `company_id`, `company_logo_url`, `company_name`, `company_slug`, `country`, `country_code`, `country_id`, `created_at_i`, `employment_type`, `employment_type_id`, `experience_bucket`, `has_salary`, `highlighted`, `location`, `location_parts`, `objectID`, `path`, `published_at_i`, `published_at_iso8601`, `role_ids`, `salary_currency`, `salary_interval`, `salary_max`, `salary_max_usd`, `salary_min`, `salary_min_usd`, `state_id`, `title`, `workplace_type_id`.

The actor now uses only this listing API. Per-job HTML detail pages were removed because they are the main blocking and runtime bottleneck.

## Description Field Check

Full `description_html` and `description_text` are not available from the public Algolia search API. These checks were tested before removing detail-page fetching:

- Algolia `getObject` for `6654883`: returned listing fields only, no description fields.
- Explicit `attributesToRetrieve` for `description`, `description_html`, `description_text`, `body`, `content`, `content_html`, `job_description`, and `summary`: returned no description fields.
- `attributesToSnippet: ["*:100"]`: returned snippets for listing fields only.
- Search for known text from a job description: returned `0` hits, proving descriptions are not indexed in the exposed search key.
- `api.startup.jobs` and guessed `/api/...` detail routes: Cloudflare-blocked or not valid job JSON.

Decision: keep the actor API-only and fast, expose all rich listing fields available from Algolia, and do not perform detail-page HTML parsing for descriptions.

## Fields Currently Missing In Actor

The previous output did not expose these useful listing fields directly:

`country_code`, `country_id`, `city_id`, `state_id`, `company_id`, `role_ids`, `location_parts`, `published_at_i`, `created_at_i`, `has_salary`, `salary_interval`, `salary_min_usd`, `salary_max_usd`, `_geoloc`, `highlighted`.

These fields are now mapped into the actor output where present.

## Candidate Matrix

| Candidate | Header profile | Status/body marker | Fields | Pagination | Decision |
|---|---|---:|---:|---|---|
| Algolia `Post_production/query` | Desktop bootstrap + direct JSON POST | `200`, JSON with `hits` | 34 listing fields | `page`, `hitsPerPage` | Selected |
| Startup.jobs listing HTML | Desktop browser headers | `200`, Algolia meta tags present | Config only | URL filters | Used only to bootstrap search key |
| Startup.jobs listing HTML | iOS Safari headers | `403`, challenge body | 0 | None | Rejected |
| Startup.jobs listing HTML | Android/okhttp headers | `403`, challenge body | 0 | None | Rejected |
| `https://startup.jobs/api/search` | Desktop browser headers | `404` | 0 | Unknown | Rejected |
| `https://startup.jobs/graphql` | Desktop browser headers | `200`, HTML page not GraphQL JSON | 0 | Unknown | Rejected |
| `https://api.startup.jobs/` | Desktop/iOS/Android headers | `200`, small status JSON | 0 job fields | None | Rejected |
| `/_next/data/.../remote-jobs.json` guess | Desktop browser headers | `404`, tiny JSON | 0 | Unknown | Rejected |
| URLScan existing scans | Public URLScan result API | Search found scans; result fetch returned `403` or no useful JSON | 0 | Unknown | Rejected |

## Scoring

| Factor | Points |
|---|---:|
| Returns JSON directly | 30 |
| Has more than 15 unique fields | 25 |
| No private auth required | 20 |
| Has pagination support | 15 |
| Matches current fields | 10 |
| **Total** | **100** |

The selected Algolia endpoint clears the 50-point minimum and is fully HTTP-based.

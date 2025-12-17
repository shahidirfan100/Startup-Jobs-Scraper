# Startup Jobs Scraper

Extract remote job listings from **Startup.jobs** - the leading job board for startup and tech company positions worldwide. Get comprehensive job data including titles, companies, locations, salaries, and full descriptions.

---

## What This Scraper Does

Startup Jobs Scraper automatically extracts job listings from Startup.jobs, providing structured data ready for analysis, integration, or personal job tracking.

### How It Works (Cheap Hybrid Strategy)

- **1) Playwright listing**: Opens the results page once and extracts job detail URLs (handles dynamic rendering / Cloudflare).
- **2) HTTP + Cheerio details (cheap)**: Fetches each job detail page with `got-scraping` and parses JSON-LD/HTML using Cheerio.
- **3) Playwright fallback (only when blocked)**: If a detail page is Cloudflare-blocked over HTTP, loads it in Playwright and parses the HTML.

### Key Capabilities

- **Remote Job Focus** - Specialized for remote and distributed work opportunities
- **Comprehensive Data** - Extracts titles, companies, locations, job types, salaries, and descriptions
- **Flexible Search** - Filter by keywords, location, and job categories
- **Scalable Collection** - Gather from 10 to 500+ listings per run
- **Production Ready** - Handles rate limiting and anti-bot measures automatically

---

## Use Cases

| Industry | Application |
|----------|-------------|
| **Recruitment** | Build candidate sourcing databases for startup roles |
| **Job Seekers** | Track and monitor new remote opportunities automatically |
| **Market Research** | Analyze startup hiring trends and salary benchmarks |
| **HR Analytics** | Study demand for skills across the startup ecosystem |
| **Career Platforms** | Integrate startup job data into your application |

---

## Input Configuration

### Basic Example - Remote Software Jobs

```json
{
  "keyword": "software engineer",
  "results_wanted": 50
}
```

### Advanced Example - Full Configuration

```json
{
  "keyword": "product manager",
  "location": "Remote",
  "collectDetails": true,
  "results_wanted": 100,
  "max_pages": 5,
  "maxConcurrency": 2,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Custom URL Example

```json
{
  "startUrl": "https://startup.jobs/remote-jobs?w=remote&q=data+scientist",
  "results_wanted": 30,
  "collectDetails": true
}
```

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | - | Custom Startup.jobs URL. Overrides other search parameters when set. |
| `keyword` | String | No | `""` | Search terms for job titles or skills (e.g., "react developer", "marketing manager"). |
| `location` | String | No | `"Remote"` | Location filter. Use "Remote" for remote-only positions. |
| `collectDetails` | Boolean | No | `true` | Extract full job descriptions by visiting detail pages. Set to `false` for faster runs with basic data only. |
| `results_wanted` | Integer | No | `25` | Maximum jobs to extract (1-500). |
| `max_pages` | Integer | No | `3` | Maximum listing pages to process (1-20). |
| `maxConcurrency` | Integer | No | `2` | Concurrent browser sessions (1-5). Lower values are more reliable. |
| `proxyConfiguration` | Object | No | Apify Residential | Proxy settings for the scraper. Residential proxies recommended. |

---

## Output Data

Each job listing contains the following fields:

### Sample Output

```json
{
  "id": "7565554",
  "title": "Senior Software Engineer",
  "company": "TechStartup Inc.",
  "location": "Remote",
  "job_type": "Full-time",
  "salary": "$120,000 - $180,000",
  "description_text": "We are looking for a senior software engineer to join our growing team...",
  "description_html": "<div>We are looking for a senior software engineer...</div>",
  "company_logo": "https://startup.jobs/cdn/logos/company.png",
  "posted_at": "2 days ago",
  "apply_link": "https://startup.jobs/apply/7565554",
  "url": "https://startup.jobs/senior-software-engineer-techstartup-7565554",
  "source": "html",
  "fetched_at": "2024-01-15T10:30:00.000Z"
}
```

### Output Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique job identifier |
| `title` | String | Job position title |
| `company` | String | Hiring company name |
| `location` | String | Work location (typically "Remote") |
| `job_type` | String | Employment type (Full-time, Part-time, Contract) |
| `salary` | String | Compensation details when available |
| `description_text` | String | Clean text job description |
| `description_html` | String | Full HTML description with formatting |
| `company_logo` | String | URL to company logo image |
| `posted_at` | String | When the job was posted |
| `apply_link` | String | Direct application URL |
| `url` | String | Job detail page URL |
| `source` | String | Data extraction method |
| `fetched_at` | String | Timestamp of data extraction |

---

## Performance and Cost

### Recommended Settings

| Use Case | Jobs | Details | Pages | Concurrency | Estimated Time |
|----------|------|---------|-------|-------------|----------------|
| Quick Test | 10 | Yes | 1 | 2 | ~1 minute |
| Standard Run | 50 | Yes | 3 | 2 | ~3 minutes |
| Large Collection | 200 | Yes | 10 | 3 | ~8 minutes |
| Speed Optimized | 100 | No | 5 | 3 | ~2 minutes |

### Tips for Best Results

1. **Start with a test run** using 10-25 jobs to verify configuration
2. **Enable Apify Proxy** with residential IPs for reliable results
3. **Use lower concurrency** (2) for more consistent data extraction
4. **Set `collectDetails: false`** for faster runs when only basic info is needed

---

## Integration Options

### Export Formats

Download your data in multiple formats directly from Apify:

- **JSON** - Structured data for applications and APIs
- **CSV** - Spreadsheet-compatible format
- **Excel** - Direct import to Microsoft Excel
- **XML** - For legacy system integration

### API Access

Access results programmatically via the Apify API:

```
GET https://api.apify.com/v2/datasets/{datasetId}/items
```

### Webhooks and Scheduling

- **Webhooks** - Get notified when runs complete
- **Scheduling** - Automate daily, weekly, or custom schedules
- **Integration** - Connect with Zapier, Make, or custom workflows

---

## Troubleshooting

### No Results Found

- Verify the keyword matches actual job listings on Startup.jobs
- Try broader search terms
- Check if the website is accessible in your region

### Timeout Errors

- Reduce `results_wanted` and `max_pages` values
- Lower `maxConcurrency` to 1 or 2
- Ensure proxy configuration is enabled

### Incomplete Data

- Enable `collectDetails: true` for full job descriptions
- Some jobs may have limited information posted
- Older listings may have expired or been removed

### Blocked Requests

- Enable Apify Proxy with residential IP groups
- Reduce concurrency to minimize detection
- Consider running during off-peak hours
- If Cloudflare blocks HTTP, Playwright fallback will automatically bootstrap cookies; for best reliability, use residential proxies.

---

## Legal and Compliance

This scraper extracts publicly available job listing data from Startup.jobs. Users are responsible for:

- Complying with Startup.jobs terms of service
- Respecting rate limits and fair use policies
- Following applicable data protection regulations
- Using extracted data responsibly and ethically

---

## Support

For questions, issues, or feature requests:

- Review the input configuration examples above
- Check the troubleshooting section for common issues
- Test with smaller result sets before scaling up

---

**Keywords**: startup jobs, remote jobs, tech jobs, startup careers, software engineer jobs, product manager jobs, remote work, tech hiring, job scraping, career data, employment listings, startup recruitment, tech talent

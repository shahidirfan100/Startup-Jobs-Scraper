# Startup Jobs Scraper

Extract startup and remote job listings from Startup.jobs in a fast, reliable, automated workflow. Collect complete hiring data including job titles, company details, salary ranges, posting dates, and descriptions for research, monitoring, and analysis. This scraper is built for teams that need consistent job market data at scale.

## Features

- **Comprehensive Job Collection** — Gather job records with title, company, location, salary, tags, and posting metadata.
- **Description Enrichment** — Capture detailed job descriptions and clean text for analysis-ready datasets.
- **Flexible Search Inputs** — Filter by keyword, location, and listing URL to target specific job segments.
- **Scalable Output Control** — Set result and page limits to balance data depth, speed, and cost.
- **Reliable Anti-Blocking Handling** — Keep extraction stable even when websites apply protection layers.

## Use Cases

### Talent Intelligence
Track hiring demand across startup roles, locations, and experience levels. Build weekly or daily trend snapshots for leadership and recruiting teams.

### Recruitment Operations
Create fresh candidate sourcing datasets by collecting new openings and role attributes automatically. Reduce manual job-board monitoring effort.

### Compensation Research
Analyze salary ranges by function, seniority, and market. Support compensation benchmarking and talent planning with structured data.

### Product and Market Research
Monitor role requirements, skills demand, and company hiring patterns over time. Identify emerging trends in startup hiring strategies.

### Job Alert Platforms
Feed downstream tools and internal dashboards with normalized job records. Power notifications, matching logic, and searchable job databases.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | — | Custom Startup.jobs listing URL. When provided, it overrides other search filters. |
| `keyword` | String | No | `""` | Search phrase for job targeting, such as role, function, or skill keywords. |
| `location` | String | No | `"Remote"` | Location filter. Use `"Remote"` for remote-first job collection. |
| `collectDetails` | Boolean | No | `true` | Include enriched job descriptions and additional detail fields. |
| `results_wanted` | Integer | No | `20` | Maximum number of jobs to collect in a run (`1` to `500`). |
| `max_pages` | Integer | No | `3` | Maximum number of listing pages to process (`1` to `20`). |
| `maxConcurrency` | Integer | No | `2` | Concurrency setting for extraction stability and speed (`1` to `5`). |

---

## Output Data

Each dataset item contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique job identifier. |
| `title` | String | Job title. |
| `company` | String | Hiring company name. |
| `location` | String | Job location or remote status. |
| `job_type` | String | Employment type (for example full-time or part-time). |
| `salary` | String | Human-readable salary value when available. |
| `posted_at` | String | Job publish timestamp. |
| `description_text` | String | Plain text job description for analysis workflows. |
| `description_html` | String | Rich job description content. |
| `company_logo` | String | Company logo URL when available. |
| `apply_link` | String | Application or job destination link. |
| `url` | String | Job page URL. |
| `source` | String | Extraction source indicator. |
| `fetched_at` | String | Data collection timestamp (ISO format). |
| `tags` | Array | Role or topic tags related to the job. |
| `workplace_type` | String | Workplace model label. |
| `employment_type` | String | Employment type code from listing data. |
| `experience_bucket` | String | Experience level category when provided. |
| `salary_min` | Number | Minimum salary value when available. |
| `salary_max` | Number | Maximum salary value when available. |
| `salary_currency` | String | Salary currency code. |
| `city` | String | City value when available. |
| `country` | String | Country value when available. |
| `company_slug` | String | Company slug identifier. |

---

## Usage Examples

### Basic Remote Collection

```json
{
  "location": "Remote",
  "results_wanted": 20
}
```

### Keyword-Focused Extraction

```json
{
  "keyword": "software engineer",
  "location": "Remote",
  "results_wanted": 50,
  "max_pages": 5,
  "collectDetails": true
}
```

### Custom Listing URL

```json
{
  "startUrl": "https://startup.jobs/remote-jobs?w=remote&q=data+scientist",
  "results_wanted": 30,
  "max_pages": 3,
  "collectDetails": true
}
```

## Sample Output

```json
{
  "id": "6654883",
  "title": "Senior Full Stack Engineer",
  "company": "Solace",
  "location": "Remote",
  "job_type": "Full Time",
  "salary": "USD 150000 - 200000",
  "posted_at": "2026-01-22T16:50:47Z",
  "description_text": "As a Full Stack Engineer, you'll join a talented team and own delivery from requirements through release...",
  "description_html": "<div class=\"trix-content\">...</div>",
  "company_logo": "https://startup.jobs/logos/34127",
  "apply_link": "https://startup.jobs/apply/4cec53b4-9d8e-4ce7-989b-b9f0e163de13",
  "url": "https://startup.jobs/senior-full-stack-engineer-solace-6654883",
  "source": "listing+details",
  "fetched_at": "2026-02-14T05:28:50.151Z",
  "tags": ["Engineer", "Full Stack", "Senior"]
}
```

---

## Tips for Best Results

### Start with QA-Friendly Limits
- Begin with `results_wanted: 20` to validate settings quickly.
- Increase volume after confirming output quality and stability.

### Use Specific Keywords
- Combine role and specialty terms to narrow results.
- Use broader keywords when building market-wide datasets.

### Tune Concurrency Carefully
- Keep `maxConcurrency` low for stability on protected pages.
- Increase gradually when throughput is stable.

### Keep Runs Fast
- Start with `results_wanted: 20` and scale up once the run profile is stable.
- Increase `maxConcurrency` gradually and monitor runtime versus failure rate.

---

## Integrations

Connect your dataset with:

- **Google Sheets** — Share and analyze hiring data quickly.
- **Airtable** — Build searchable internal hiring intelligence tables.
- **Make** — Automate downstream workflows and alerts.
- **Zapier** — Trigger notifications and CRM updates.
- **Webhooks** — Deliver fresh run results to your own endpoints.

### Export Formats

- **JSON** — API and engineering workflows.
- **CSV** — Spreadsheet analysis and BI import.
- **Excel** — Business reporting and operations review.
- **XML** — Legacy system integrations.

---

## Frequently Asked Questions

### How many jobs can I collect per run?
You can request up to `500` items per run using `results_wanted`.

### Can I collect full job descriptions?
Yes. Keep `collectDetails` enabled to gather enriched description fields.

### Why are some fields empty?
Some listings do not publish every field (for example salary or location detail), so those values may be null.

### How do I make runs more reliable?
Use residential proxies, keep concurrency moderate, and start with focused filters.

### Can I schedule this scraper daily?
Yes. You can schedule runs from Apify to keep your dataset continuously updated.

### Is this suitable for analytics pipelines?
Yes. The output is normalized and export-friendly for dashboards, alerts, and data warehouses.

---

## Support

For issues or feature requests, use support channels in the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection and analysis. Users are responsible for complying with applicable laws, platform terms, and responsible data usage practices.

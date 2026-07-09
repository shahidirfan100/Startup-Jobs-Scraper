# Startup Jobs Scraper

Extract startup job listings from Startup.jobs for hiring research, compensation analysis, and market monitoring. Collect structured job data including titles, companies, locations, salary ranges, posting dates, logos, tags, role IDs, and job links in a fast automated run.

## Features

- **Startup Job Collection** - Gather remote and startup job records with core hiring details.
- **Keyword And Location Filters** - Target roles, skills, remote jobs, or custom Startup.jobs listing URLs.
- **Rich Listing Records** - Capture salary, location, company, role, posting date, and geo fields when available.
- **Clean Dataset Output** - Duplicate jobs are skipped and empty values are removed from records.
- **Fast QA-Friendly Runs** - Start with 20 results and increase volume after confirming the output.

## Use Cases

### Talent Intelligence

Track hiring demand across startup roles, company types, and experience levels. Build repeatable datasets for recruiting strategy, workforce planning, and market snapshots.

### Recruitment Operations

Collect fresh job openings for sourcing workflows, job alerts, or internal research dashboards. Use keyword and location filters to focus on the roles your team cares about.

### Compensation Research

Analyze published salary ranges by role, company, location, and seniority. Combine `salary_min`, `salary_max`, and `salary_currency` fields with posting dates to monitor pay trends.

### Market Research

Study startup hiring patterns, role requirements, company activity, and remote work availability. Export results to spreadsheets or BI tools for further analysis.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | - | Custom Startup.jobs listing URL. When provided, it overrides keyword and location filters. |
| `keyword` | String | No | `""` | Job title, skill, or search phrase to target. |
| `location` | String | No | `"Remote"` | Location filter. Use `Remote` for remote-first collection. |
| `results_wanted` | Integer | No | `20` | Maximum number of jobs to collect, from `1` to `500`. |
| `max_pages` | Integer | No | `3` | Maximum number of result pages to process, from `1` to `20`. |

---

## Output Data

Each dataset item can contain:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique job identifier. |
| `title` | String | Job title. |
| `company` | String | Hiring company name. |
| `location` | String | Job location or remote status. |
| `job_type` | String | Human-readable employment type. |
| `salary` | String | Human-readable salary range when published. |
| `posted_at` | String | Job publish timestamp. |
| `company_logo` | String | Company logo URL. |
| `apply_link` | String | Application or job destination link. |
| `url` | String | Startup.jobs listing URL. |
| `source` | String | Source label for listing records. |
| `fetched_at` | String | Collection timestamp in ISO format. |
| `tags` | Array | Role, function, or topic tags. |
| `workplace_type` | String | Workplace model, such as remote. |
| `employment_type` | String | Published employment type code. |
| `experience_bucket` | String | Experience level category when provided. |
| `salary_min` | Number | Minimum salary value when published. |
| `salary_max` | Number | Maximum salary value when published. |
| `salary_currency` | String | Salary currency code. |
| `city` | String | City when provided. |
| `country` | String | Country when provided. |
| `country_code` | String | Country code when provided. |
| `country_id` | Number | Startup.jobs country identifier. |
| `city_id` | Number | Startup.jobs city identifier. |
| `state_id` | Number | Startup.jobs state identifier. |
| `company_id` | Number | Startup.jobs company identifier. |
| `company_slug` | String | Company slug identifier. |
| `role_ids` | Array | Role category IDs associated with the job. |
| `location_parts` | Array | Structured location parts. |
| `published_at_unix` | Number | Publish timestamp as Unix seconds. |
| `created_at_unix` | Number | Creation timestamp as Unix seconds. |
| `has_salary` | Boolean | Whether a salary range is published. |
| `salary_interval` | String | Salary period, such as year. |
| `salary_min_usd` | Number | Minimum salary converted to USD when available. |
| `salary_max_usd` | Number | Maximum salary converted to USD when available. |
| `geo_lat` | Number | Latitude when provided. |
| `geo_lng` | Number | Longitude when provided. |
| `highlighted` | Boolean | Whether the listing is highlighted. |
| `missing_fields` | Array | Core fields unavailable for that record, only included when needed. |

---

## Usage Examples

### Basic Remote Collection

```json
{
    "location": "Remote",
    "results_wanted": 20
}
```

### Keyword-Focused Search

```json
{
    "keyword": "software engineer",
    "location": "Remote",
    "results_wanted": 50,
    "max_pages": 5
}
```

### Custom Listing URL

```json
{
    "startUrl": "https://startup.jobs/remote-jobs?w=remote&q=data+scientist",
    "results_wanted": 30,
    "max_pages": 3
}
```

---

## Sample Output

```json
{
    "id": "8007953",
    "title": "Sr. Applied AI Engineer",
    "company": "Vi",
    "location": "Remote",
    "job_type": "Full Time",
    "posted_at": "2026-07-03T19:53:30Z",
    "company_logo": "https://startup.jobs/logos/38591",
    "apply_link": "https://startup.jobs/sr-applied-ai-engineer-vi-co-8007953",
    "url": "https://startup.jobs/sr-applied-ai-engineer-vi-co-8007953",
    "source": "listing-api",
    "fetched_at": "2026-07-09T14:07:36.988Z",
    "tags": ["Artificial Intelligence", "Engineer"],
    "workplace_type": "remote",
    "employment_type": "full-time",
    "experience_bucket": "3-6",
    "salary_currency": "USD",
    "country_code": "US",
    "country_id": 77,
    "company_id": 38591,
    "role_ids": [1, 8],
    "published_at_unix": 1783108410,
    "created_at_unix": 1783100100,
    "has_salary": false,
    "country": "United States",
    "company_slug": "vi-co"
}
```

---

## Tips for Best Results

### Start Small

- Use `results_wanted: 20` for quick validation.
- Increase result volume after checking the dataset shape.

### Use Focused Searches

- Combine role and skill terms for targeted datasets.
- Use a custom listing URL when Startup.jobs filters already match your needs.

### Review Missing Fields

- Some employers do not publish salary, city, or full descriptions.
- Check `missing_fields` when it appears to understand record-level gaps.

---

## Integrations

Connect your data with:

- **Google Sheets** - Review and share hiring data.
- **Airtable** - Build searchable recruiting databases.
- **Make** - Automate alerts and downstream workflows.
- **Zapier** - Trigger updates in CRM or notification tools.
- **Webhooks** - Send fresh run results to your systems.

### Export Formats

- **JSON** - For data pipelines and apps.
- **CSV** - For spreadsheets and analysis.
- **Excel** - For reporting and operations.
- **XML** - For legacy integrations.

---

## Frequently Asked Questions

### How many jobs can I collect?

You can collect up to `500` jobs per run using `results_wanted`.

### Can I collect full job descriptions?

No, full descriptions are not included because the fast listing source does not publish them. The actor prioritizes stable listing records over slow page-detail collection.

### Why are some fields missing?

Some companies do not publish every field, such as salary or city. Empty values are removed, and `missing_fields` appears if a core field is unavailable.

### Can I schedule daily job monitoring?

Yes, schedule recurring runs in Apify to keep your dataset fresh.

### Is the output ready for analysis?

Yes, records are structured, duplicate job IDs are skipped, and empty values are cleaned from each item.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection and analysis. Users are responsible for complying with applicable laws, website terms, and responsible data usage practices.

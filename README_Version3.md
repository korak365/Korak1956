# Code-Base Crawler

Scrapes public GitHub and GitLab repositories searching for specific libraries and files to build datasets for training coding assistants.

## Features

- Crawl GitHub and GitLab search results and repository pages.
- Extract repository metadata: name, URL, description, stars, forks, primary language.
- Scan repository files for package manifests and dependency lists (package.json, requirements.txt, pyproject.toml).
- Produce structured dataset suitable for downstream analysis and ingestion.

## Installation

1. Create project folder and paste files into `.actor/` and `src/`.
2. Install dependencies:
```bash
npm install
```

## Usage

Run locally (uses defaults defined in `.actor/input_schema.json`):
```bash
apify run
```

Example input (storage/key_value_stores/default/INPUT.json):
```json
{
  "startUrls": [
    { "url": "https://github.com/search?q=express+middleware&type=Repositories" }
  ],
  "maxRequestsPerCrawl": 500,
  "minStars": 50,
  "languages": ["JavaScript", "Python"],
  "includeForks": false,
  "scanFiles": ["package.json","requirements.txt","pyproject.toml","Dockerfile"]
}
```

## Deploy

Authenticate and deploy:
```bash
apify login
apify push
```

## Output Format

Each dataset item resembles:
```json
{
  "repoName": "owner/repo",
  "repoUrl": "https://github.com/owner/repo",
  "description": "Short description",
  "stars": 123,
  "forks": 10,
  "language": "JavaScript",
  "matchedFiles": ["package.json","Dockerfile"],
  "matchedDependencies": ["express","lodash"],
  "host": "github.com",
  "timestamp": "2026-05-06T12:34:56Z"
}
```

## Legal & Ethical

- Respect robots.txt and platform Terms of Service.
- For GitHub/GitLab heavy collection consider using official APIs and authenticated access to obey rate limits.
- Do not collect or store private/personal data.
- Use the dataset ethically and respect software licenses.

## License

ISC
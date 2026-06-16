# FCA Dashboard — IDX Graduation Tracker

A real-time dashboard for tracking FCA (Foreign Capital Accumulation) graduation progress on the Indonesia Stock Exchange (IDX). Powered by Stockbit API with Yahoo Finance fallback.

**Live:** https://fca-dashboard-gamma.vercel.app

## What It Does

Tracks stocks that meet FCA criteria and monitors their progress toward "graduation" — the point where foreign capital accumulation hits a target threshold over a defined period.

**Key metrics displayed:**
- Full target, current total, and shortfall
- Average daily accumulation needed
- Remaining trading sessions
- Monthly breakdown of foreign flow
- Progress-to-target with scenario modeling
- Gap per day analysis

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Static HTML, vanilla JS, Inter + JetBrains Mono fonts |
| Backend | Vercel Serverless Function (Node.js) |
| Data API | Stockbit (primary), Yahoo Finance (fallback) |
| Database | SQLite (`trading-db/idx.db`) |
| Hosting | Vercel |

No build step. No framework. Just HTML + a serverless API.

## Project Structure

```
fca-dashboard/
├── api/
│   ├── index.js          # Serverless API — fetches stock data
│   └── data/
│       ├── fca-lists.json    # Generated FCA stock lists & metadata
│       └── fca-holidays.json # IDX holiday calendar
├── public/
│   ├── index.html        # Dashboard UI (current)
│   └── index.v1.html     # Earlier version (backup)
├── scripts/
│   └── generate-fca-data.py  # Generates JSON from SQLite DB
├── vercel.json           # Vercel config
└── package.json
```

## Setup

### Prerequisites
- Vercel account
- Node.js (for local dev)
- Python 3 (for data generation)
- SQLite database at `trading-db/idx.db`

### Environment Variables

Set in Vercel dashboard:

| Variable | Description |
|----------|-------------|
| `STOCKTOKEN` | Stockbit API auth token |

### Generate FCA Data

The FCA stock lists are generated from a local SQLite database:

```bash
python3 scripts/generate-fca-data.py
```

This reads from `trading-db/idx.db` and outputs:
- `api/data/fca-lists.json` — active FCA stocks, criteria, period info
- `api/data/fca-holidays.json` — IDX trading holidays

### Deploy

```bash
cd projects/fca-dashboard
git push origin main
vercel deploy --prod --yes
```

### Local Development

```bash
cd projects/fca-dashboard
vercel dev
```

## Data Pipeline

```
SQLite DB → generate-fca-data.py → JSON files → API reads → Frontend displays
```

1. **SQLite DB** (`idx.db`) stores historical FCA data, stock info, and daily foreign flow
2. **Python script** queries the DB and generates JSON files with current FCA lists
3. **Serverless API** reads the JSON, fetches live prices from Stockbit/Yahoo Finance
4. **Frontend** displays the dashboard with real-time calculations

## Monthly Maintenance

FCA lists need periodic regeneration as stocks graduate or new ones qualify:

```bash
# Regenerate from updated DB
python3 scripts/generate-fca-data.py

# Commit the new JSON
git add api/data/
git commit -m "update: FCA lists for [MONTH]"
git push origin main

# Redeploy
vercel deploy --prod --yes
```

## Glossary

| Term | Meaning |
|------|---------|
| **FCA** | Foreign Capital Accumulation |
| **Graduation** | When a stock's foreign accumulation hits the target threshold |
| **Full Target** | Total FCA shares needed for graduation |
| **Current Total** | Shares accumulated so far |
| **Shortfall** | Remaining shares needed |
| **Avg Needed** | Daily average accumulation required for remaining sessions |
| **Gap/Day** | Difference between actual daily avg and required avg |
| **Scenarios** | Best/worst/realistic completion projections |

## License

Internal use — Growinc Group Indonesia.

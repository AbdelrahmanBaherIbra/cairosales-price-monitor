# Cairo Sales — Competitor Price Monitor

Daily competitor price monitoring and comparison dashboard. Pilot dataset: **69 Bosch
products** compared against **13 competitors** (2B, Raya, Carrefour, Al Salem, iMedia,
Amazon, Jumia, Noon, B.TECH, Gaballah, Dream 2000, El Araby, Bosch).

## How it works

```
Vercel Cron (daily)  ─▶  /api/cron/refresh  ─▶  tiered fetcher  ─▶  price_snapshots (append-only)
                                                     │
Dashboard (/)  ◀──  SQL comparison view  ◀──────────┘
```

- **Matching** is by **Bosch model code** (e.g. `KGN56LB3E9`). Those codes are unique and
  appear in competitor product pages, so `/api/match?slug=<competitor>` searches each site
  for the code and proposes a product URL (`auto_found`). A human confirms it (`confirmed`).
- **Fetching** is tiered per competitor (`competitors.fetch_method`):
  - `jsonld` — direct fetch + schema.org JSON-LD (most sites).
  - `selector` — direct fetch, JSON-LD first then a configured `config.priceRegex`.
  - `api` — third-party scraping API for the blockers (Amazon / Noon / Jumia).
- **Threshold / MAP** — Bosch sets a minimum price per product. Any competitor priced below
  it is flagged (amber) on the dashboard and in `price_snapshots.below_threshold`.

## Data lives in the Cairo Sales Supabase project

All tables are in the **`price_monitor`** schema of the existing Cairo Sales project
(`tepyapssrofxuwonqepv`), isolated from the ERP tables. Schema is in
`supabase/migrations/0001_price_monitor.sql`. RLS is enabled with no public policies; the
app connects directly to Postgres server-side (never via the public REST API).

## Setup

```bash
npm install
cp .env.example .env.local   # fill in SUPABASE_DB_URL and CRON_SECRET
npm run dev
```

`SUPABASE_DB_URL` — Supabase → Project Settings → Database → Connection string →
**Transaction pooler** (port 6543), for serverless/Vercel.

## Operating it

| Action | Command |
|---|---|
| Import / update products | `npm run import:products path/to/export.xlsx` |
| Auto-match a competitor | `POST /api/match?slug=btech` (Bearer `CRON_SECRET`) |
| Confirm matches | flip `competitor_products.match_status` to `confirmed` |
| Manual price refresh | `GET /api/cron/refresh` (Bearer `CRON_SECRET`) |
| Daily refresh | Vercel Cron, `vercel.json` → 05:00 UTC (07:00 Cairo) |

## Build order (status)

1. ✅ Supabase schema + 13 competitors + 69 Bosch products seeded
2. ✅ Excel/CSV importer
3. ✅ Model-code matcher (`/api/match`)
4. ✅ Tiered fetcher (JSON-LD + selector + scraping-API)
5. ✅ Comparison dashboard (delta colouring, rank, MAP flags)
6. ✅ Daily cron + append-only history + per-product trend chart
7. ⏭️ Next: run the matcher against B.TECH, confirm ~20 URLs, do the first real refresh,
   then roll out the remaining competitors and wire a scraping-API key for Amazon/Noon/Jumia.

## Deploying

Deploy to Vercel. Set `SUPABASE_DB_URL`, `CRON_SECRET`, and (optional)
`SCRAPER_API_KEY` in project env. The cron in `vercel.json` runs automatically.

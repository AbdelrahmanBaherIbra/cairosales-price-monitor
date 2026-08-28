# Scraping the geo-blocked competitors (Egyptian egress)

Some competitors block GitHub Actions' US datacenter IP and only serve real pages
to an **Egyptian IP**. They must be scraped from a machine in Egypt (your laptop,
an Egyptian VPS, or via a residential proxy pointed at Egypt) — never from the
GitHub runner, where they return a block/404 shell.

| Competitor | On GitHub Actions (US) | From an Egyptian IP |
| --- | --- | --- |
| **noon** | bot-challenge shell → 0 priced | full prices |
| **elaraby** | `tiba=404` shell for every URL → 0 matched | full prices |
| carrefour | usually works; occasional partial block | reliable |

The clean sites (raya, btech, abdulaziz, 2b, gaballah) work fine on GitHub and are
**not** listed here — leave them on the scheduled cloud workflows. `noon` and
`elaraby` are excluded from the cloud scrape by default (`SCRAPE_EXCLUDE`), and
the datacenter Noon cron is disabled.

## Prerequisites (once per machine)

- Node 20+ and git on PATH (`node -v`, `git --version`)
- `git clone` this repo, then `npm install` and `npx playwright install chromium`
- The `SUPABASE_DB_URL` transaction-pooler connection string (Supabase dashboard →
  project → Project Settings → Database → Connection string → Transaction pooler)

## Set the DB URL for the session

macOS / Linux (bash/zsh):

```bash
export SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@<host>.pooler.supabase.com:6543/postgres"
```

Windows (PowerShell):

```powershell
$env:SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@<host>.pooler.supabase.com:6543/postgres"
```

## Run

Two modes: **match** finds and saves product URLs; **refresh** re-prices URLs already
matched. `SCRAPE_DRYRUN=1` scrapes and logs prices but writes nothing (use it to
confirm the IP works before a real run). `SCRAPE_LIMIT` caps match mode only;
scope either mode with `SCRAPE_BRAND`.

Dry run (safe — no DB writes):

```bash
SCRAPE_DRYRUN=1 SCRAPE_MODE=match SCRAPE_SLUGS=noon,elaraby SCRAPE_LIMIT=5 npm run scrape
```

Real match (first-time — populates mappings, needed for elaraby which has none):

```bash
SCRAPE_MODE=match SCRAPE_SLUGS=noon,elaraby npm run scrape
```

Real refresh (day-to-day — re-price existing matches):

```bash
SCRAPE_MODE=refresh SCRAPE_SLUGS=noon,elaraby npm run scrape
```

(PowerShell: set each `$env:VAR="..."` on its own, then `npm run scrape` — it can't
use the `VAR=value command` prefix.)

## Making it permanent

The laptop is fine for testing and ad-hoc runs, but as a standing daily job it's
unreliable (a laptop sleeps) and funnels all traffic through one home IP, which
can get that IP rate-limited. For an always-on setup, run these same commands on a
cron from **an Egyptian VPS** (a few $/month) or route the scraper through a
**residential proxy pointed at Egypt**. Keep the clean sites on GitHub Actions
either way — its per-shard IPs spread the load.

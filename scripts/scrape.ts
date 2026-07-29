/**
 * JavaScript-rendering scraper — runs in GitHub Actions (see
 * .github/workflows/scrape.yml), NOT on Vercel.
 *
 * For each competitor it: renders the search page for a Bosch model code with a
 * real browser, finds the product URL (reusing findCandidateInHtml on the
 * rendered DOM), stores the mapping, then renders that product page and extracts
 * the price from its JSON-LD. All results are appended to price_snapshots.
 *
 * Env:
 *   SUPABASE_DB_URL   required   Postgres connection (transaction pooler)
 *   SCRAPE_SLUGS      optional   comma-separated competitor slugs (default: all active)
 *   SCRAPE_LIMIT      optional   max products per competitor (default: all)
 *   SCRAPE_CONCURRENCY optional  parallel pages (default 3)
 *   RENDER_WAIT_MS    optional   extra wait after load for JS (default 2500)
 */
import { chromium, type Browser, type BrowserContext } from "playwright";
import { query, closePool } from "../src/lib/db";
import { findCandidateInHtml } from "../src/lib/match/modelCode";
import { extractOfferFromHtml, extractProductsFromHtml } from "../src/lib/fetchers/html";
import { mapPool } from "../src/lib/pool";
import type { Competitor } from "../src/lib/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const WAIT = Number(process.env.RENDER_WAIT_MS ?? 4000);
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY ?? 3);

interface Product {
  id: string;
  model_code: string;
  threshold_price: number | null;
}

async function render(ctx: BrowserContext, url: string): Promise<string | null> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Let client-side search results / prices load, then nudge lazy content.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(WAIT);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1000);
    return await page.content();
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeCompetitor(browser: Browser, competitor: Competitor, products: Product[]) {
  if (!competitor.search_url_template) {
    console.log(`  [${competitor.slug}] no search_url_template, skipping`);
    return;
  }
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US" });
  let matched = 0;
  let priced = 0;

  await mapPool(products, CONCURRENCY, async (p, index) => {
    const searchUrl = competitor.search_url_template!.replace(
      "{query}",
      encodeURIComponent(p.model_code),
    );
    const searchHtml = await render(ctx, searchUrl);
    if (!searchHtml) {
      if (index === 0) console.log(`  [${competitor.slug}] DEBUG render returned null for ${searchUrl}`);
      return;
    }

    if (process.env.SCRAPE_DEBUG && index === 0) {
      debugDump(competitor.slug, p.model_code, searchUrl, searchHtml);
    }

    const candidate = findCandidateInHtml(searchHtml, p.model_code, competitor);
    if (!candidate) return;
    matched++;

    const cp = await query<{ id: string }>(
      `insert into competitor_products
         (tracked_product_id, competitor_id, product_url, match_status, match_confidence)
       values ($1,$2,$3,'auto_found',$4)
       on conflict (tracked_product_id, competitor_id)
       do update set product_url = excluded.product_url,
                     match_confidence = excluded.match_confidence,
                     match_status = case when competitor_products.match_status='confirmed'
                                    then 'confirmed' else 'auto_found' end
       returning id`,
      [p.id, competitor.id, candidate.url, candidate.confidence],
    );

    // Render the product page and extract its price.
    const prodHtml = await render(ctx, candidate.url);
    const offer = prodHtml ? extractOfferFromHtml(prodHtml) : null;
    const price = offer?.price ?? null;
    const belowThreshold =
      price != null && p.threshold_price != null ? price < Number(p.threshold_price) : null;
    if (price != null) priced++;

    await query(
      `insert into price_snapshots
         (competitor_product_id, price, currency, in_stock, below_threshold, fetch_status, raw)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        cp[0].id,
        price,
        offer?.currency ?? "EGP",
        offer?.inStock ?? null,
        belowThreshold,
        price != null ? "ok" : "not_found",
        offer ? JSON.stringify(offer.raw) : null,
      ],
    );
  });

  await ctx.close();
  console.log(`  [${competitor.slug}] scanned ${products.length}, matched ${matched}, priced ${priced}`);
}

function debugDump(slug: string, code: string, url: string, html: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const c = norm(code);
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const withCode = hrefs.filter((h) => norm(h).includes(c));
  const htmlLinks = hrefs.filter((h) => /\.html?($|\?)/i.test(h));
  const products = extractProductsFromHtml(html)
    .slice(0, 5)
    .map((p) => ({ url: p.url, sku: p.sku, name: p.name?.slice(0, 40) }));
  console.log(`  [${slug}] === DEBUG ${code} ===`);
  console.log(`    searchUrl: ${url}`);
  console.log(`    htmlLen: ${html.length}  totalHrefs: ${hrefs.length}  .htmlLinks: ${htmlLinks.length}`);
  console.log(`    codeInHtml: ${norm(html).includes(c)}`);
  console.log(`    jsonldProducts: ${JSON.stringify(products)}`);
  console.log(`    hrefsContainingCode: ${JSON.stringify(withCode.slice(0, 5))}`);
  console.log(`    sample .htmlLinks: ${JSON.stringify(htmlLinks.slice(0, 8))}`);
}

async function main() {
  const slugsArg = process.env.SCRAPE_SLUGS?.split(",").map((s) => s.trim()).filter(Boolean);
  const limit = process.env.SCRAPE_LIMIT ? Number(process.env.SCRAPE_LIMIT) : null;

  const competitors = await query<Competitor>(
    `select * from competitors
     where is_active and search_url_template is not null
       and ($1::text[] is null or slug = any($1))
     order by slug`,
    [slugsArg && slugsArg.length ? slugsArg : null],
  );
  const products = await query<Product>(
    `select id, model_code, threshold_price from tracked_products
     where is_active order by model_code ${limit ? "limit " + limit : ""}`,
  );

  console.log(`Scraping ${competitors.length} competitor(s) x ${products.length} products`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (const c of competitors) {
      console.log(`[${c.slug}] starting…`);
      await scrapeCompetitor(browser, c, products);
    }
  } finally {
    await browser.close();
    await closePool();
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

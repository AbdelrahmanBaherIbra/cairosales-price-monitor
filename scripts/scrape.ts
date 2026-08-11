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
import {
  findCandidateInHtml,
  extractProductCandidates,
  type MatchCandidate,
} from "../src/lib/match/modelCode";
import {
  extractOfferFromHtml,
  extractProductsFromHtml,
  priceFromDataLayer,
  type ParsedOffer,
} from "../src/lib/fetchers/html";
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

/**
 * Render a competitor's search page and find the product URL for a code.
 *   1) findCandidateInHtml (code in URL / JSON-LD sku) — precise.
 *   2) DOM tile fallback: locate the product tile whose visible text contains
 *      the EXACT code and take that tile's product link. Catches products with
 *      opaque URLs (e.g. B.TECH's /en/p/<uuid>) without matching cousin models.
 */
async function searchAndMatch(
  ctx: BrowserContext,
  competitor: Competitor,
  code: string,
): Promise<{ candidate: MatchCandidate | null; html: string } | null> {
  const searchUrl = competitor.search_url_template!.replaceAll(
    "{query}",
    encodeURIComponent(code),
  );
  const page = await ctx.newPage();
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(WAIT);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1000);
    const html = await page.content();

    let candidate = findCandidateInHtml(html, code, competitor);
    if (!candidate) {
      const url = await page
        .evaluate((codeArg: string) => {
          const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const c = norm(codeArg);
          const isProd = (h: string | null) =>
            !!h &&
            /\/(p|product|products|item|dp)\//i.test(h) &&
            !/\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)/i.test(h);
          const anchors = (Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[])
            .filter((a) => isProd(a.getAttribute("href")));
          // The right product card is the one whose OWN content references the
          // exact code (e.g. its product-image URL embeds the SKU). This scopes
          // per-card, so a cousin model's card is never picked.
          for (const a of anchors) {
            if (norm(a.outerHTML).includes(c)) return a.href;
          }
          // Some cards keep the image just outside the link — widen to the card.
          for (const a of anchors) {
            const card = a.closest("article, li, [class*='card'], [class*='product']") ?? a.parentElement;
            if (card && norm(card.outerHTML).includes(c)) return a.href;
          }
          return null;
        }, code)
        .catch(() => null);
      if (url) candidate = { url, confidence: 0.8 };
    }
    if (process.env.SCRAPE_DEBUG) {
      const diag = await page
        .evaluate((codeArg: string) => {
          const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const c = norm(codeArg);
          const anchors = (Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[])
            .filter((a) => /\/p\//i.test(a.getAttribute("href") || ""));
          return anchors.slice(0, 6).map((a) => ({
            href: (a.getAttribute("href") || "").slice(0, 55),
            codeInAnchor: norm(a.outerHTML).includes(c),
            imgs: a.querySelectorAll("img").length,
          }));
        }, code)
        .catch(() => []);
      console.log(`  [${competitor.slug}] DOM anchors: ${JSON.stringify(diag)}`);
    }
    return { candidate, html };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Open candidate product pages from a search result and return the first whose
 * MAIN product identity (title / h1 / JSON-LD sku|name) contains the exact code.
 * Cousin-safe: a page for a different model won't carry the searched code as its
 * identity. Returns that page's parsed offer so the caller needn't re-fetch.
 */
async function verifyOnProductPages(
  ctx: BrowserContext,
  competitor: Competitor,
  code: string,
  searchHtml: string,
): Promise<{ url: string; offer: ParsedOffer | null } | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const c = norm(code);
  const candidates = extractProductCandidates(searchHtml, competitor).slice(0, 5);
  for (const url of candidates) {
    const prodHtml = await render(ctx, url);
    if (!prodHtml) continue;
    const title = norm(prodHtml.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "");
    const h1 = norm((prodHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, ""));
    const inIdentity = extractProductsFromHtml(prodHtml).some(
      (pr) => norm(pr.sku ?? "").includes(c) || norm(pr.name ?? "").includes(c),
    );
    if (title.includes(c) || h1.includes(c) || inIdentity) {
      return { url, offer: extractOfferFromHtml(prodHtml) };
    }
  }
  return null;
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
    const result = await searchAndMatch(ctx, competitor, p.model_code);
    if (!result) {
      if (index === 0) console.log(`  [${competitor.slug}] DEBUG search render failed`);
      return;
    }
    let candidate = result.candidate;
    // Verify-on-product-page fallback: for sites whose search cards aren't real
    // links (B.TECH), open each candidate product page and accept the first
    // whose title/JSON-LD carries the EXACT code. Reuses that page's price.
    let prefetchedOffer: ParsedOffer | null | undefined;
    if (!candidate) {
      const verified = await verifyOnProductPages(ctx, competitor, p.model_code, result.html);
      if (verified) {
        candidate = { url: verified.url, confidence: 0.8 };
        prefetchedOffer = verified.offer;
      }
    }
    // GA4 dataLayer (server-rendered) — reliable name+price on Magento sites like
    // 2B. Confirms a match when the JS tiles didn't render, and supplies price.
    const dlPrice = priceFromDataLayer(result.html, p.model_code);
    if (!candidate && dlPrice != null) {
      const searchUrl = competitor.search_url_template!.replaceAll("{query}", encodeURIComponent(p.model_code));
      candidate = { url: searchUrl, confidence: 0.85 };
    }
    if (process.env.SCRAPE_DEBUG && index === 0) {
      const searchUrl = competitor.search_url_template!.replaceAll("{query}", encodeURIComponent(p.model_code));
      debugDump(competitor.slug, p.model_code, searchUrl, result.html);
      console.log(`  [${competitor.slug}] candidate: ${candidate?.url ?? "none"} (conf ${candidate?.confidence ?? "-"})`);
    }
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

    // Reuse the verify-path offer, else render the product page for its price.
    // Skip the product-page fetch when the URL is just the search page (dataLayer
    // match) — there's no product JSON-LD to gain there.
    let offer: ParsedOffer | null;
    const isSearchFallbackUrl = candidate.url.includes("catalogsearch") || candidate.url.includes("/s?q=");
    if (prefetchedOffer !== undefined) {
      offer = prefetchedOffer;
    } else if (isSearchFallbackUrl) {
      offer = null;
    } else {
      const prodHtml = await render(ctx, candidate.url);
      offer = prodHtml ? extractOfferFromHtml(prodHtml) : null;
    }
    // Price: product-page JSON-LD if present, else the dataLayer price.
    const price = offer?.price ?? dlPrice ?? null;
    if (process.env.SCRAPE_DEBUG && index === 0) {
      console.log(`  [${competitor.slug}] product page: price=${price}`);
    }
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
  // Embedded data-blob diagnostics: where does the code live in the page source?
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const prodPaths = hrefs.filter((h) => /\/p\//i.test(h)).slice(0, 6);
  console.log(`    __NEXT_DATA__: ${nd ? nd[1].length + " chars" : "absent"}  __next_f: ${/__next_f/.test(html)}`);
  console.log(`    productPathHrefs: ${JSON.stringify(prodPaths)}`);
  const lower = html.toLowerCase();
  const cl = code.toLowerCase();
  const ctxs: string[] = [];
  for (let idx = lower.indexOf(cl); idx !== -1 && ctxs.length < 4; idx = lower.indexOf(cl, idx + cl.length)) {
    ctxs.push(html.slice(Math.max(0, idx - 160), idx + 160).replace(/\s+/g, " "));
  }
  ctxs.forEach((ctx, i) => console.log(`    ctx${i}: …${ctx}…`));
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
  const codeFilter = process.env.SCRAPE_CODE?.split(",").map((s) => s.trim()).filter(Boolean);
  const products = await query<Product>(
    `select id, model_code, threshold_price from tracked_products
     where is_active and ($1::text[] is null or model_code = any($1))
     order by model_code ${limit ? "limit " + limit : ""}`,
    [codeFilter && codeFilter.length ? codeFilter : null],
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

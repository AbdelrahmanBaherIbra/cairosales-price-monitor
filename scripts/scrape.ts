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
 *   SCRAPE_EXCLUDE    optional   comma-separated slugs to skip (e.g. noon runs in its own workflow)
 *   SCRAPE_BRAND      optional   limit to one brand's products (match: which to find; refresh: which to re-price)
 *   SCRAPE_LIMIT      optional   max products per competitor (default: all)
 *   SCRAPE_CONCURRENCY optional  parallel pages while matching (default 3)
 *   REFRESH_CONCURRENCY optional parallel pages for clean sites on refresh (default 6)
 *   RENDER_WAIT_MS    optional   extra wait after load for JS (default 4000)
 *   FAST_CAP_MS       optional   max poll for a server-rendered price on refresh (default 3000)
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext } from "playwright";
import { query, closePool } from "../src/lib/db";

// Stealth: hides the headless-browser fingerprints (navigator.webdriver, etc.)
// that bot-protection uses to flag automated traffic.
const chromium = chromiumExtra;
chromium.use(StealthPlugin());
import {
  findCandidateInHtml,
  extractProductCandidates,
  type MatchCandidate,
} from "../src/lib/match/modelCode";
import { codeKeys, matchesAnyKey } from "../src/lib/match/codeKeys";
import {
  extractOfferFromHtml,
  extractProductsFromHtml,
  priceFromDataLayer,
  type ParsedOffer,
} from "../src/lib/fetchers/html";
import { mapPool } from "../src/lib/pool";
import type { Competitor } from "../src/lib/types";

// The stealth plugin fires CDP commands at each new page; when a page/context
// closes while one is still in flight (common with many parallel contexts) it
// rejects with a benign "Target ... has been closed". Swallow only that — any
// other unhandled rejection is a real bug and should still fail the run.
process.on("unhandledRejection", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (/target.*(closed|has been closed)|context or browser has been closed/i.test(msg)) return;
  console.error("Unhandled rejection:", err);
  process.exit(1);
});

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const WAIT = Number(process.env.RENDER_WAIT_MS ?? 4000);
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY ?? 3);
// Daily refresh only re-reads known URLs, so it can run the clean (non-throttled)
// sites much wider than matching does.
const REFRESH_CONC = Number(process.env.REFRESH_CONCURRENCY ?? 6);
// Fast path: how long to poll for a server-rendered price before falling back to
// the full JS wait. Sites that ship price in JSON-LD return almost instantly.
const FAST_CAP = Number(process.env.FAST_CAP_MS ?? 3000);
// Block detection (refresh mode). If a single competitor's refresh pass comes
// back overwhelmingly empty, it's almost certainly a bot-block or site outage —
// not every product delisting at once. Above these thresholds we treat the pass
// as blocked and DON'T overwrite last-known prices with not_found (the Noon
// Aug-23 failure mode, where one bad run wiped 169 healthy prices to "gone").
const BLOCK_MIN_BATCH = Number(process.env.BLOCK_MIN_BATCH ?? 8);
const BLOCK_RATIO = Number(process.env.BLOCK_RATIO ?? 0.7);

interface Product {
  id: string;
  model_code: string;
  threshold_price: number | null;
}

/**
 * A browser context that never downloads images, media or fonts — we only ever
 * read HTML/JSON-LD, so blocking those bytes cuts page-load time and bandwidth
 * substantially. The <img> tags (and their src, used by the image-proximity
 * matcher) stay in the DOM; only the binary fetch is skipped.
 */
async function newCtx(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US" });
  await ctx.route("**/*", async (route) => {
    try {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") await route.abort();
      else await route.continue();
    } catch {
      // Request arrived mid-teardown; the target is gone — nothing to do.
    }
  });
  return ctx;
}

/**
 * Append a price snapshot only when the price differs from this mapping's most
 * recent snapshot — so price_snapshots becomes a change-log, not a daily dump.
 * `is distinct from` compares NULLs correctly (out-of-stock counts as a change),
 * and the not-exists arm records the first-ever reading for a new mapping.
 * Returns true when a row was actually written.
 */
async function recordSnapshotIfChanged(
  cpId: string,
  price: number | null,
  currency: string,
  inStock: boolean | null,
  below: boolean | null,
  fetchStatus: string,
  raw: string | null,
): Promise<boolean> {
  const res = await query<{ id: string }>(
    `insert into price_snapshots
       (competitor_product_id, price, currency, in_stock, below_threshold, fetch_status, raw)
     select $1,$2,$3,$4,$5,$6,$7
     where not exists (select 1 from price_snapshots where competitor_product_id = $1)
        or (select price from price_snapshots
            where competitor_product_id = $1
            order by captured_at desc limit 1) is distinct from $2::numeric
     returning id`,
    [cpId, price, currency, inStock, below, fetchStatus, raw],
  );
  return res.length > 0;
}

async function render(
  ctx: BrowserContext,
  url: string,
  opts?: { fast?: boolean },
): Promise<string | null> {
  // newPage() is inside the try: the stealth plugin occasionally times out
  // creating a page ("navigating to about:blank"). Left outside, that throw
  // escapes render() and crashes the whole shard instead of skipping one product.
  let page: Awaited<ReturnType<BrowserContext["newPage"]>> | undefined;
  try {
    page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Fast path (daily refresh): the price is often already in the server-
    // rendered JSON-LD. Poll briefly and return the instant it's there, instead
    // of always paying the full JS wait. Falls through to the slow path if the
    // price never appears within FAST_CAP (e.g. JS-rendered sites like Noon).
    if (opts?.fast) {
      const start = Date.now();
      while (Date.now() - start < FAST_CAP) {
        const html = await page.content();
        if (extractOfferFromHtml(html)?.price != null) return html;
        await page.waitForTimeout(300);
      }
    }
    // Let client-side search results / prices load, then nudge lazy content.
    await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => {});
    await page.waitForTimeout(WAIT);
    // Cloudflare interactive challenge: it auto-clears in a few seconds with a
    // real (stealth) browser — wait it out, up to ~20s, then re-read.
    for (let i = 0; i < 4; i++) {
      const html = await page.content();
      if (!/just a moment|__cf_chl|cf-challenge|cf_chl_opt|checking your browser/i.test(html)) break;
      await page.waitForTimeout(5000);
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1000);
    return await page.content();
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
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
  let page: Awaited<ReturnType<BrowserContext["newPage"]>> | undefined;
  try {
    page = await ctx.newPage();
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(WAIT);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1000);
    const html = await page.content();

    let candidate = findCandidateInHtml(html, code, competitor);
    if (!candidate) {
      const url = await page
        .evaluate((keys: string[]) => {
          const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const hasCode = (s: string | null) => {
            const h = norm(s);
            return keys.some((k) => h.includes(k));
          };
          const isProd = (h: string | null) =>
            !!h &&
            /\/(p|product|products|item|dp)\//i.test(h) &&
            !/\/(supportdetail|support|service|manuals?)(\/|\?|#|-|$)/i.test(h) &&
            !/\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)/i.test(h);
          const anchors = (Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[])
            .filter((a) => isProd(a.getAttribute("href")));
          // The right product card is the one whose OWN content references the
          // code (e.g. its product-image URL embeds the SKU). This scopes
          // per-card, so a cousin model's card is never picked.
          for (const a of anchors) {
            if (hasCode(a.outerHTML)) return a.href;
          }
          // Some cards keep the image just outside the link — widen to the card.
          for (const a of anchors) {
            const card = a.closest("article, li, [class*='card'], [class*='product']") ?? a.parentElement;
            if (card && hasCode(card.outerHTML)) return a.href;
          }
          return null;
        }, codeKeys(code))
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
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Open candidate product pages from a search result and return the first whose
 * MAIN product identity (title / h1 / JSON-LD sku|name) contains the exact code.
 * Cousin-safe: a page for a different model won't carry the searched code as its
 * identity. Returns that page's parsed offer so the caller needn't re-fetch.
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does a product page's MAIN identity (title / h1 / JSON-LD sku|name) carry the code? */
function identityHasCode(html: string, code: string): boolean {
  const keys = codeKeys(code);
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "");
  if (matchesAnyKey(title, keys) || matchesAnyKey(h1, keys)) return true;
  return extractProductsFromHtml(html).some(
    (pr) => matchesAnyKey(pr.sku ?? "", keys) || matchesAnyKey(pr.name ?? "", keys),
  );
}

async function verifyOnProductPages(
  ctx: BrowserContext,
  competitor: Competitor,
  code: string,
  searchHtml: string,
): Promise<{ url: string; offer: ParsedOffer | null } | null> {
  // Cap at 3 candidates and use the fast render — this fallback fires for every
  // product a retailer doesn't carry, so on low-coverage brands it dominates the
  // run time. The identity (code in title/JSON-LD) is in the initial HTML, so the
  // fast early-exit render is enough to confirm or reject.
  const candidates = extractProductCandidates(searchHtml, competitor).slice(0, 3);
  for (const url of candidates) {
    const prodHtml = await render(ctx, url, { fast: true });
    if (!prodHtml) continue;
    if (identityHasCode(prodHtml, code)) {
      return { url, offer: extractOfferFromHtml(prodHtml) };
    }
  }
  return null;
}

async function scrapeCompetitor(
  browser: Browser,
  competitor: Competitor,
  products: Product[],
  allCodes: string[],
) {
  if (!competitor.search_url_template) {
    console.log(`  [${competitor.slug}] no search_url_template, skipping`);
    return;
  }
  const ctx = await newCtx(browser);
  let matched = 0;
  let priced = 0;

  // Bot-protected sites (config.throttle) are scraped one-at-a-time with a delay
  // so the traffic looks human and doesn't trip rate limiting.
  const throttle = (competitor.config as { throttle?: boolean } | null)?.throttle === true;
  const conc = throttle ? 1 : CONCURRENCY;

  await mapPool(products, conc, async (p, index) => {
    if (throttle && index > 0) await new Promise((r) => setTimeout(r, 2500));
    // Fresh browser session per request for throttled sites, so bot-protection
    // can't correlate a run of requests back to one tracked session.
    const pageCtx = throttle ? await newCtx(browser) : ctx;
    try {
    const result = await searchAndMatch(pageCtx, competitor, p.model_code);
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
      const verified = await verifyOnProductPages(pageCtx, competitor, p.model_code, result.html);
      if (verified) {
        candidate = { url: verified.url, confidence: 0.8 };
        prefetchedOffer = verified.offer;
      }
    }
    // GA4 dataLayer (server-rendered) — reliable name+price on Magento sites like
    // 2B. Confirms a match when the JS tiles didn't render, and supplies price.
    const dlPrice = priceFromDataLayer(result.html, p.model_code);
    let fromDataLayer = false;
    if (!candidate && dlPrice != null) {
      const searchUrl = competitor.search_url_template!.replaceAll("{query}", encodeURIComponent(p.model_code));
      candidate = { url: searchUrl, confidence: 0.85 };
      fromDataLayer = true;
    }
    if (process.env.SCRAPE_DEBUG && index === 0) {
      const searchUrl = competitor.search_url_template!.replaceAll("{query}", encodeURIComponent(p.model_code));
      debugDump(competitor.slug, p.model_code, searchUrl, result.html);
      console.log(`  [${competitor.slug}] candidate: ${candidate?.url ?? "none"} (conf ${candidate?.confidence ?? "-"})`);
    }
    if (!candidate) return;

    const ownCode = norm(p.model_code);
    const urlPath = norm(candidate.url.split("?")[0]);

    // Bundle guard: a product URL that also contains a DIFFERENT tracked code is a
    // multi-product set (e.g. hood+hob+oven), whose price isn't this product's.
    const foreign = allCodes.find(
      (c) => c !== ownCode && c.length >= 5 && !ownCode.includes(c) && !c.includes(ownCode) && urlPath.includes(c),
    );
    if (foreign) {
      if (process.env.SCRAPE_DEBUG && index === 0)
        console.log(`  [${competitor.slug}] BUNDLE skip (${p.model_code}): url also carries ${foreign}`);
      return;
    }

    // Trusted = exact code is in the URL, or came from dataLayer (item_name match)
    // or verify-on-page (already confirmed). Everything else must be confirmed on
    // the product page, or it's a fuzzy-search cousin (e.g. WGA2540XEG for WGB2440XEG).
    const trusted = urlPath.includes(ownCode) || fromDataLayer || prefetchedOffer !== undefined;
    const isSearchFallbackUrl =
      fromDataLayer || candidate.url.includes("catalogsearch") || candidate.url.includes("/s?q=");

    let offer: ParsedOffer | null;
    if (prefetchedOffer !== undefined) {
      offer = prefetchedOffer;
    } else if (isSearchFallbackUrl) {
      offer = null;
    } else {
      const prodHtml = await render(pageCtx, candidate.url);
      if (!trusted && (!prodHtml || !identityHasCode(prodHtml, p.model_code))) {
        if (process.env.SCRAPE_DEBUG && index === 0)
          console.log(`  [${competitor.slug}] COUSIN skip (${p.model_code}): exact code not on product page`);
        return;
      }
      offer = prodHtml ? extractOfferFromHtml(prodHtml) : null;
    }

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

    // Price: product-page JSON-LD if present, else the dataLayer price.
    const price = offer?.price ?? dlPrice ?? null;
    if (process.env.SCRAPE_DEBUG && index === 0) {
      console.log(`  [${competitor.slug}] product page: price=${price}`);
    }
    const belowThreshold =
      price != null && p.threshold_price != null ? price < Number(p.threshold_price) : null;
    if (price != null) priced++;

    await recordSnapshotIfChanged(
      cp[0].id,
      price,
      offer?.currency ?? "EGP",
      offer?.inStock ?? null,
      belowThreshold,
      price != null ? "ok" : "not_found",
      offer ? JSON.stringify(offer.raw) : null,
    );
    } finally {
      if (throttle) await pageCtx.close();
    }
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

/**
 * REFRESH mode (the cheap daily job): don't search — just re-open each already
 * matched product URL and record its current price. This is ~1 page load per
 * mapping instead of a full search+match, which is what makes daily runs at
 * scale affordable.
 */
async function refreshPrices(
  browser: Browser,
  slugsArg?: string[],
  excludeArg?: string[],
  brandArg?: string | null,
) {
  const rows = await query<{
    cp_id: string;
    product_url: string;
    threshold_price: number | null;
    slug: string;
    throttle: boolean;
  }>(
    `select cp.id as cp_id, cp.product_url, tp.threshold_price, c.slug,
            coalesce((c.config->>'throttle')::boolean, false) as throttle
     from price_monitor.competitor_products cp
     join price_monitor.competitors c on c.id = cp.competitor_id and c.is_active
     join price_monitor.tracked_products tp on tp.id = cp.tracked_product_id and tp.is_active
     where cp.product_url is not null
       and cp.product_url not like '%catalogsearch%'
       and cp.product_url not like '%/s?q=%'
       and cp.product_url not like '%/search?%'
       and ($1::text[] is null or c.slug = any($1))
       and ($2::text[] is null or c.slug <> all($2))
       and ($3::text is null or tp.brand = $3)
     order by c.slug`,
    [
      slugsArg && slugsArg.length ? slugsArg : null,
      excludeArg && excludeArg.length ? excludeArg : null,
      brandArg ?? null,
    ],
  );

  type Row = (typeof rows)[number];

  type Pending = {
    cpId: string;
    price: number | null;
    currency: string;
    inStock: boolean | null;
    below: boolean | null;
    status: string;
    raw: string | null;
  };

  type Outcome = { priced: boolean; changed: boolean; empty: Pending | null };

  // Re-price one already-matched URL. A LIVE read (price found) is persisted
  // immediately — always safe, and it preserves partial progress if the pass is
  // later cancelled or times out. An EMPTY read (no price) is NOT written here:
  // it's returned for a deferred, whole-pass decision in commitSlug, so a
  // block/outage can't overwrite a good last-known price with "gone".
  const priceOne = async (ctx: BrowserContext, r: Row, fast: boolean): Promise<Outcome> => {
    const prodHtml = await render(ctx, r.product_url, { fast });
    const offer = prodHtml ? extractOfferFromHtml(prodHtml) : null;
    const price = offer?.price ?? null;
    const below =
      price != null && r.threshold_price != null ? price < Number(r.threshold_price) : null;
    const currency = offer?.currency ?? "EGP";
    const raw = offer ? JSON.stringify(offer.raw) : null;
    if (price != null) {
      const changed = await recordSnapshotIfChanged(
        r.cp_id, price, currency, offer?.inStock ?? null, below, "ok", raw,
      );
      return { priced: true, changed, empty: null };
    }
    return {
      priced: false,
      changed: false,
      empty: { cpId: r.cp_id, price: null, currency, inStock: offer?.inStock ?? null, below, status: "not_found", raw },
    };
  };

  // Decide the empty reads for one competitor once the whole pass is in. If the
  // pass came back overwhelmingly empty (>= BLOCK_RATIO of a batch of at least
  // BLOCK_MIN_BATCH), treat it as a block/outage and DROP the not_found writes —
  // leaving each product's last-known price as the latest, instead of silently
  // overwriting a healthy dataset with "gone" (the Noon Aug-23 failure mode).
  // Successful reads were already saved by priceOne. Returns a log summary.
  const commitSlug = async (slug: string, outcomes: Outcome[]): Promise<string> => {
    const attempted = outcomes.length;
    const priced = outcomes.filter((o) => o.priced).length;
    const empties = outcomes.map((o) => o.empty).filter((e): e is Pending => e != null);
    const empty = empties.length;
    let changed = outcomes.filter((o) => o.changed).length;
    const blocked = attempted >= BLOCK_MIN_BATCH && empty / attempted >= BLOCK_RATIO;
    if (!blocked) {
      for (const p of empties) {
        const wrote = await recordSnapshotIfChanged(
          p.cpId, p.price, p.currency, p.inStock, p.below, p.status, p.raw,
        );
        if (wrote) changed++;
      }
    }
    return blocked
      ? `  [${slug}] BLOCKED: ${empty}/${attempted} empty in one pass — kept last-known prices (not overwritten); saved ${priced} live reads`
      : `  [${slug}] refreshed ${attempted}, priced ${priced}, changed ${changed}`;
  };

  // Split by politeness: clean sites run wide in one shared context; throttled
  // sites (bot-protected) each get their own context, one page at a time. The
  // two groups run concurrently, so the run finishes in ~max(group time), not
  // the sum — Noon's deliberate delay no longer blocks Bosch/Raya/etc.
  const fastRows: Row[] = [];
  const throttledBySlug = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.throttle) {
      if (!throttledBySlug.has(r.slug)) throttledBySlug.set(r.slug, []);
      throttledBySlug.get(r.slug)!.push(r);
    } else {
      fastRows.push(r);
    }
  }

  const jobs: Promise<void>[] = [];

  if (fastRows.length) {
    jobs.push(
      (async () => {
        const ctx = await newCtx(browser);
        try {
          const results = await mapPool(fastRows, REFRESH_CONC, (r) => priceOne(ctx, r, true));
          // Group by competitor so block detection is per-site, not across the
          // whole clean pool (one site blocking mustn't suppress another's writes).
          const bySlug = new Map<string, Outcome[]>();
          results.forEach((o, i) => {
            if (!o) return;
            const s = fastRows[i].slug;
            let arr = bySlug.get(s);
            if (!arr) { arr = []; bySlug.set(s, arr); }
            arr.push(o);
          });
          for (const [slug, outcomes] of bySlug) console.log(await commitSlug(slug, outcomes));
        } finally {
          await ctx.close();
        }
      })(),
    );
  }

  for (const [slug, list] of throttledBySlug) {
    jobs.push(
      (async () => {
        const ctx = await newCtx(browser);
        try {
          const results = await mapPool(list, 1, async (r, i) => {
            if (i > 0) await new Promise((res) => setTimeout(res, 2500));
            return priceOne(ctx, r, false);
          });
          console.log(await commitSlug(slug, results.filter(Boolean) as Outcome[]));
        } finally {
          await ctx.close();
        }
      })(),
    );
  }

  await Promise.all(jobs);
}

async function main() {
  const mode = process.env.SCRAPE_MODE || "refresh"; // 'refresh' (daily) | 'match' (find URLs)
  const slugsArg = process.env.SCRAPE_SLUGS?.split(",").map((s) => s.trim()).filter(Boolean);
  const excludeArg = process.env.SCRAPE_EXCLUDE?.split(",").map((s) => s.trim()).filter(Boolean);
  const limit = process.env.SCRAPE_LIMIT ? Number(process.env.SCRAPE_LIMIT) : null;

  if (mode === "refresh") {
    const brandArg = process.env.SCRAPE_BRAND?.trim() || null;
    console.log(`Mode: refresh (price-only on existing matches)${brandArg ? ` (brand: ${brandArg})` : ""}`);
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try {
      await refreshPrices(browser, slugsArg, excludeArg, brandArg);
    } finally {
      await browser.close();
      await closePool();
    }
    console.log("Done.");
    return;
  }

  const competitors = await query<Competitor>(
    `select * from competitors
     where is_active and search_url_template is not null
       and ($1::text[] is null or slug = any($1))
       and ($2::text[] is null or slug <> all($2))
     order by slug`,
    [slugsArg && slugsArg.length ? slugsArg : null, excludeArg && excludeArg.length ? excludeArg : null],
  );
  const codeFilter = process.env.SCRAPE_CODE?.split(",").map((s) => s.trim()).filter(Boolean);
  const brandArg = process.env.SCRAPE_BRAND?.trim() || null; // roll out brand by brand
  const products = await query<Product>(
    `select id, model_code, threshold_price from tracked_products
     where is_active and ($1::text[] is null or model_code = any($1))
       and ($2::text is null or brand = $2)
     order by model_code ${limit ? "limit " + limit : ""}`,
    [codeFilter && codeFilter.length ? codeFilter : null, brandArg],
  );

  // Codes for the bundle guard: scope to the same brand being matched — a URL
  // carrying a DIFFERENT brand's code isn't a bundle, and matching all 3k+ codes
  // would cause false bundle-skips on coincidental substrings.
  const allCodeRows = await query<{ model_code: string }>(
    `select model_code from tracked_products where is_active and ($1::text is null or brand = $1)`,
    [brandArg],
  );
  const allCodes = allCodeRows.map((r) => norm(r.model_code));

  console.log(
    `Mode: match — ${competitors.length} competitor(s) x ${products.length} products` +
      (brandArg ? ` (brand: ${brandArg})` : ""),
  );
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (const c of competitors) {
      console.log(`[${c.slug}] starting…`);
      await scrapeCompetitor(browser, c, products, allCodes);
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

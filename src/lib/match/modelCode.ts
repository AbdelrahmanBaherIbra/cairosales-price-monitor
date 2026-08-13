import type { Competitor } from "@/lib/types";
import { extractProductsFromHtml } from "@/lib/fetchers/html";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface MatchCandidate {
  url: string;
  confidence: number; // 0..1
}

/**
 * Find a competitor's product URL for a Bosch model code.
 *
 * Strategy, strongest first:
 *   1. Read the search page's JSON-LD Product nodes; match the code against
 *      sku / mpn / name / url. This is the most reliable signal (Egyptian
 *      Magento sites emit ItemList+Product JSON-LD on search results).
 *   2. Fall back to product-looking anchor hrefs (incl. Magento ".html" URLs)
 *      whose text/URL contains the code.
 *
 * Returns the best candidate or null. Human confirmation flips match_status to
 * "confirmed"; this only proposes.
 */
export async function findByModelCode(
  competitor: Competitor,
  modelCode: string,
): Promise<MatchCandidate | null> {
  if (!competitor.search_url_template) return null;
  const code = normalise(modelCode);
  const searchUrl = competitor.search_url_template.replaceAll(
    "{query}",
    encodeURIComponent(modelCode),
  );

  let html: string;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(t);
    // Some sites return a 404 status but still render valid search results.
    if (res.status >= 500) return null;
    html = await res.text();
  } catch {
    return null;
  }

  return findCandidateInHtml(html, modelCode, competitor);
}

/**
 * Pure matcher: given already-fetched search-page HTML (from a plain fetch OR a
 * Playwright render), find the best product URL for the model code. Shared by
 * the API route and the Playwright scraper.
 */
export function findCandidateInHtml(
  html: string,
  modelCode: string,
  competitor: Competitor,
): MatchCandidate | null {
  const code = normalise(modelCode);

  // 1. JSON-LD products — but never accept a URL that is itself a search page
  // (some sites emit a placeholder Product/Offer whose url is the search URL),
  // nor a manufacturer support page (Bosch's JSON-LD points at /supportdetail/,
  // which has no price — skip it so the code-in-URL step can find the shop page).
  const products = extractProductsFromHtml(html).filter(
    (p) => p.url && !isSearchUrl(p.url) && !isSupportPage(p.url),
  );
  for (const p of products) {
    const skuHit = p.sku && normalise(p.sku).includes(code);
    const mpnHit = p.mpn && normalise(p.mpn).includes(code);
    if ((skuHit || mpnHit) && p.url) return { url: absolute(p.url, competitor), confidence: 0.97 };
  }
  for (const p of products) {
    const nameHit = p.name && normalise(p.name).includes(code);
    const urlHit = p.url && normalise(p.url).includes(code);
    if ((nameHit || urlHit) && p.url) return { url: absolute(p.url, competitor), confidence: 0.85 };
  }

  // 2. Anchor-href fallback: a link whose URL contains the model code itself
  // (e.g. Raya slugs like /ar/...-kgn56lb3e9-29351). This is a strong, precise
  // signal. We deliberately do NOT guess from "only one product on the page" —
  // that produced false matches (e.g. code mentioned in a related-items strip).
  const base = competitor.website_url ?? "";
  const candidates = extractAllLinks(html, base)
    .filter((l) => !isSearchUrl(l) && !isAsset(l) && !isSupportPage(l)) // skip assets & support pages
    .filter((l) => normalise(l).includes(code));
  if (candidates.length) {
    // Product images often embed the code too, but live on a media/cdn host —
    // prefer a real product-path link on the main site.
    const best =
      candidates.find(isProductPath) ??
      candidates.find((l) => !isAssetHost(l)) ??
      candidates[0];
    return { url: best, confidence: 0.85 };
  }

  // 3. Proximity fallback: the exact code appears somewhere in a product card
  // (e.g. inside the card's image URL) with no code in any product link. Take
  // the product-path link physically nearest to a code occurrence in the HTML.
  // Cousin-safe: a different model's code never appears, so nothing matches.
  const prox = findByProximity(html, modelCode, base);
  if (prox) return { url: prox, confidence: 0.8 };

  return null;
}

/**
 * All candidate product-page URLs on a search page, in document order (≈ search
 * relevance). Used by the scraper's verify-on-product-page fallback for sites
 * whose search cards aren't real links (e.g. B.TECH's JS-built UUID cards).
 */
export function extractProductCandidates(html: string, competitor: Competitor): string[] {
  const base = competitor.website_url ?? "";
  const re = /href=["']([^"']+)["']/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const abs = toAbsolute(m[1], base);
    if (!abs || isSearchUrl(abs) || isAsset(abs) || isSupportPage(abs) || !isProductPath(abs)) continue;
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/**
 * Nearest product-path link to a code-bearing PRODUCT IMAGE in the page source.
 * We anchor on the code inside an image filename (which always lives in the
 * right product card) — NOT on any code occurrence, since the header search box
 * echoes the code too and would drag matches to whatever card renders first.
 */
function findByProximity(html: string, modelCode: string, base: string): string | null {
  const needle = modelCode.toLowerCase();
  if (needle.length < 4) return null;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // code embedded in an image URL, e.g. .../36d9..._SMS6EMI62V_STP_def.png
  const imgRe = new RegExp(`[^"'\\s>]*${esc}[^"'\\s>]*\\.(?:png|jpe?g|webp|gif|svg|avif)`, "gi");
  const anchors: number[] = [];
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html)) !== null) anchors.push(im.index);
  if (!anchors.length) return null;

  const hrefRe = /href=["']([^"']+)["']/gi;
  let best: { url: string; dist: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const abs = toAbsolute(m[1], base);
    if (!abs || isSearchUrl(abs) || isAsset(abs) || isSupportPage(abs) || !isProductPath(abs)) continue;
    let dist = Infinity;
    for (const cp of anchors) dist = Math.min(dist, Math.abs(cp - m.index));
    if (!best || dist < best.dist) best = { url: abs, dist };
  }
  // Only trust a link that sits close to the image (same card), not page-wide.
  return best && best.dist < 4000 ? best.url : null;
}

/** Asset URLs (images, styles, scripts, docs) are never product pages. */
function isAsset(url: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|pdf|css|js|mp4|webm|woff2?)(\?|#|$)/i.test(url);
}

function isAssetHost(url: string): boolean {
  try {
    return /^(media|cdn|images?|img|assets?|static)\./i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isProductPath(url: string): boolean {
  return /\/(p|product|products|item|dp)\//i.test(url) || /-\d{3,}(\?|#|$)/.test(url);
}

/**
 * Manufacturer support / manuals / service pages. These are real pages that
 * mention the model code and sit under /product/, so they look like product
 * pages — but they never carry a price (e.g. Bosch's /supportdetail/product/…).
 * Excluding them steers matches to the actual shop page.
 */
function isSupportPage(url: string): boolean {
  return /\/(supportdetail|support|service|manuals?|installationguide)(\/|\?|#|-|$)/i.test(url);
}

/** True for search / listing URLs, which are never valid product matches. */
function isSearchUrl(url: string): boolean {
  return /catalogsearch|[?&]q=|[?&]keyword=|[?&]search=|\/search(\/|\?|$)/i.test(url);
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function absolute(href: string, competitor: Competitor): string {
  return toAbsolute(href, competitor.website_url ?? "") ?? href;
}

/** All absolute, same-origin http(s) links on the page. */
function extractAllLinks(html: string, base: string): string[] {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const abs = hrefs
    .map((h) => toAbsolute(h, base))
    .filter((h): h is string => !!h && /^https?:/i.test(h));
  return [...new Set(abs)];
}

function toAbsolute(href: string, base: string): string | null {
  try {
    if (href.startsWith("http")) return href;
    if (!base) return null;
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

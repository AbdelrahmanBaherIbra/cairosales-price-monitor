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
  // (some sites emit a placeholder Product/Offer whose url is the search URL).
  const products = extractProductsFromHtml(html).filter(
    (p) => p.url && !isSearchUrl(p.url),
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
    .filter((l) => !isSearchUrl(l) && !isAsset(l)) // skip image/asset URLs
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

  return null;
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

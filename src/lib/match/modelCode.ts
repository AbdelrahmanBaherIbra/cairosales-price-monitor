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
  const searchUrl = competitor.search_url_template.replace(
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
  if (products.length === 1 && products[0].url && normalise(html).includes(code)) {
    return { url: absolute(products[0].url, competitor), confidence: 0.7 };
  }

  // 2. Anchor-href fallback. The strongest signal is a link whose URL contains
  // the model code itself (e.g. Raya slugs like /ar/...-kgn56lb3e9-29351) —
  // check ALL non-search links, regardless of URL shape.
  const base = competitor.website_url ?? "";
  const allLinks = extractAllLinks(html, base).filter((l) => !isSearchUrl(l));
  const inUrl = allLinks.find((l) => normalise(l).includes(code));
  if (inUrl) return { url: inUrl, confidence: 0.85 };

  // Weaker: exactly one product-looking link on a page that mentions the code.
  const productLinks = allLinks.filter(isProductLike);
  if (normalise(html).includes(code) && productLinks.length === 1) {
    return { url: productLinks[0], confidence: 0.5 };
  }
  return null;
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

/** Heuristic: does this URL look like a product page (not a category/cms page)? */
function isProductLike(h: string): boolean {
  if (/\/(category|categories|cms|blog|account|cart|checkout|wishlist|compare|login)\//i.test(h)) {
    return false;
  }
  return (
    /\/(p|product|products|item|dp)\//i.test(h) || // /product/ style
    /-p-?\d/i.test(h) || // ...-p-12345
    /-\d{3,}(\?|$)/.test(h) || // ...-29351 (Raya-style trailing id)
    /\.html?($|\?)/i.test(h) // Magento .html
  );
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

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

  // 1. JSON-LD products
  const products = extractProductsFromHtml(html);
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
  // If exactly one product is listed and the code is on the page, take it.
  if (products.length === 1 && products[0].url && normalise(html).includes(code)) {
    return { url: absolute(products[0].url, competitor), confidence: 0.7 };
  }

  // 2. Anchor-href fallback
  const links = extractProductLinks(html, competitor.website_url ?? "");
  const inUrl = links.find((l) => normalise(l).includes(code));
  if (inUrl) return { url: inUrl, confidence: 0.8 };
  if (normalise(html).includes(code) && links.length === 1) {
    return { url: links[0], confidence: 0.5 };
  }
  return null;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function absolute(href: string, competitor: Competitor): string {
  return toAbsolute(href, competitor.website_url ?? "") ?? href;
}

function extractProductLinks(html: string, base: string): string[] {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const abs = hrefs
    .map((h) => toAbsolute(h, base))
    .filter((h): h is string => !!h)
    .filter(
      (h) =>
        /\/(p|product|products|item|dp)\//i.test(h) || // /product/ style
        /-p-?\d/i.test(h) || // ...-p-12345
        (/\.html?($|\?)/i.test(h) && !/\/(category|cms|blog|account|cart|checkout|wishlist)\//i.test(h)), // Magento .html
    );
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

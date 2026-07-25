import type { Competitor, PriceResult } from "@/lib/types";
import { fetchJsonLd } from "./jsonld";
import { fetchViaScraperApi } from "./scraperApi";

/**
 * Tiered price fetcher. Picks the strategy from the competitor's fetch_method:
 *
 *   jsonld   -> direct fetch + schema.org JSON-LD (most sites)
 *   selector -> direct fetch; JSON-LD first, then a configured price regex
 *   api      -> third-party scraping API (Amazon / Noon / Jumia — the blockers)
 *
 * Always resolves (never throws) so one bad page can't abort a daily run.
 */
export async function fetchPrice(
  competitor: Competitor,
  url: string,
): Promise<PriceResult> {
  switch (competitor.fetch_method) {
    case "api":
      return fetchViaScraperApi(url);

    case "selector": {
      const viaJsonLd = await fetchJsonLd(url);
      if (viaJsonLd.fetch_status === "ok") return viaJsonLd;
      return fetchViaSelector(url, competitor);
    }

    case "jsonld":
    default:
      return fetchJsonLd(url);
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Fallback for sites without clean JSON-LD. The competitor's `config.priceRegex`
 * (a string regex with one capture group for the number) is applied to the raw
 * HTML. Kept dependency-free on purpose; upgrade to a headless browser only for
 * the specific sites that need it.
 */
async function fetchViaSelector(
  url: string,
  competitor: Competitor,
): Promise<PriceResult> {
  const pattern = competitor.config?.priceRegex as string | undefined;
  if (!pattern) {
    return { price: null, currency: "EGP", in_stock: null, fetch_status: "not_found" };
  }
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (res.status === 403 || res.status === 429) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "blocked" };
    }
    if (!res.ok) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "error" };
    }
    const html = await res.text();
    const m = html.match(new RegExp(pattern));
    const price = m ? parseFloat(m[1].replace(/[^0-9.]/g, "")) : NaN;
    if (!Number.isFinite(price)) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "not_found" };
    }
    return { price, currency: "EGP", in_stock: null, fetch_status: "ok" };
  } catch {
    return { price: null, currency: "EGP", in_stock: null, fetch_status: "error" };
  }
}

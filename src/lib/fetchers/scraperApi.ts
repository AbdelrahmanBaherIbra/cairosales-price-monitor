import type { PriceResult } from "@/lib/types";
import { extractOfferFromHtml } from "./html";

/**
 * Fetch a page through a third-party scraping API for the sites that block
 * direct requests (Amazon.eg, Noon, Jumia). The API handles proxies, JS
 * rendering and CAPTCHAs; we still parse the returned HTML with the same
 * JSON-LD extractor.
 *
 * Configure SCRAPER_API_KEY to enable. Without a key this returns "blocked"
 * so those competitors are simply skipped (and shown as such in the dashboard)
 * rather than failing the run.
 */
export async function fetchViaScraperApi(url: string): Promise<PriceResult> {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) {
    return { price: null, currency: "EGP", in_stock: null, fetch_status: "blocked" };
  }
  const provider = process.env.SCRAPER_API_PROVIDER ?? "zyte";
  try {
    const html = await renderHtml(provider, key, url);
    if (!html) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "error" };
    }
    const offer = extractOfferFromHtml(html);
    if (!offer || offer.price == null) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "not_found" };
    }
    return {
      price: offer.price,
      currency: offer.currency ?? "EGP",
      in_stock: offer.inStock,
      fetch_status: "ok",
      raw: offer.raw,
    };
  } catch {
    return { price: null, currency: "EGP", in_stock: null, fetch_status: "error" };
  }
}

async function renderHtml(provider: string, key: string, url: string): Promise<string | null> {
  if (provider === "zyte") {
    const res = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${key}:`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, browserHtml: true }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { browserHtml?: string };
    return data.browserHtml ?? null;
  }
  // scraperapi.com style
  const endpoint = `https://api.scraperapi.com/?api_key=${key}&render=true&url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint);
  if (!res.ok) return null;
  return await res.text();
}

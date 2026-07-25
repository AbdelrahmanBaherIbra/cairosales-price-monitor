import type { PriceResult } from "@/lib/types";
import { extractOfferFromHtml } from "./html";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Fetch a product page directly and extract price from schema.org JSON-LD.
 *
 * This is the highest-leverage extractor: most Egyptian e-commerce sites embed
 * a <script type="application/ld+json"> Product/Offer block, which is far more
 * stable across redesigns than CSS selectors. Returns a graceful status so the
 * tiered dispatcher can fall through to the next method.
 */
export async function fetchJsonLd(url: string): Promise<PriceResult> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
    });
    if (res.status === 403 || res.status === 429) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "blocked" };
    }
    if (!res.ok) {
      return { price: null, currency: "EGP", in_stock: null, fetch_status: "error" };
    }
    html = await res.text();
  } catch {
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
}

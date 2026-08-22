/** Shared schema.org JSON-LD extraction, used by both the direct and API fetchers. */
import { codeKeys, matchesAnyKey } from "@/lib/match/codeKeys";

export interface ParsedOffer {
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  raw: unknown;
}

export interface JsonLdProduct {
  url: string | null;
  sku: string | null;
  mpn: string | null;
  name: string | null;
  price: number | null;
}

/** All Product nodes found in a page's JSON-LD (incl. ItemList members). */
export function extractProductsFromHtml(html: string): JsonLdProduct[] {
  const out: JsonLdProduct[] = [];
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const [, body] of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(body.trim());
    } catch {
      continue;
    }
    collectProducts(json, out);
  }
  return out;
}

function collectProducts(node: unknown, out: JsonLdProduct[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProducts(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if ("@graph" in obj) collectProducts(obj["@graph"], out);

  // ItemList -> itemListElement -> ListItem.item (or direct Product)
  if ("itemListElement" in obj) collectProducts(obj["itemListElement"], out);
  if ("item" in obj) collectProducts(obj["item"], out);

  const type = obj["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) {
    const offer = obj.offers ? parseOffers(obj.offers) : null;
    out.push({
      url: str(obj.url) ?? str(obj["@id"]),
      sku: str(obj.sku),
      mpn: str(obj.mpn),
      name: str(obj.name),
      price: offer?.price ?? null,
    });
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function extractOfferFromHtml(html: string): ParsedOffer | null {
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const [, body] of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const offer = findProductOffer(json);
    if (offer) return offer;
  }
  return null;
}

/** Walk arbitrarily nested JSON-LD (incl. @graph) for a Product's offers. */
function findProductOffer(node: unknown): ParsedOffer | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductOffer(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  if ("@graph" in obj) {
    const found = findProductOffer(obj["@graph"]);
    if (found) return found;
  }

  const type = obj["@type"];
  const isProduct =
    type === "Product" || (Array.isArray(type) && type.includes("Product"));

  if (isProduct && obj.offers) return parseOffers(obj.offers);
  if (type === "Offer" || type === "AggregateOffer") return parseOffers(obj);
  return null;
}

function parseOffers(offers: unknown): ParsedOffer | null {
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (!o || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;
  const rawPrice =
    obj.price ??
    obj.lowPrice ??
    (obj.priceSpecification as Record<string, unknown> | undefined)?.price;
  const price = toNumber(rawPrice);
  const availability = String(obj.availability ?? "").toLowerCase();
  const inStock = availability
    ? availability.includes("instock") || availability.includes("in_stock")
    : null;
  return {
    price,
    currency: (obj.priceCurrency as string) ?? null,
    inStock,
    raw: obj,
  };
}

/**
 * Price from a GA4 / dataLayer ecommerce items block, matched by the model code
 * appearing in item_name. Many Magento sites (e.g. 2B) server-render this even
 * when the product page has no JSON-LD and the visual tiles load via JS.
 */
export function priceFromDataLayer(html: string, modelCode: string): number | null {
  const keys = codeKeys(modelCode);
  if (keys[0].length < 4) return null;
  const re = /"item_name"\s*:\s*"([^"]+)"[\s\S]{0,400}?"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (matchesAnyKey(m[1], keys)) {
      const p = parseFloat(m[2]);
      if (Number.isFinite(p) && p > 0) return p;
    }
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  // A price of 0 (or negative) is a placeholder / out-of-stock marker, never a
  // real price — treat it as "no price".
  return Number.isFinite(n) && n > 0 ? n : null;
}

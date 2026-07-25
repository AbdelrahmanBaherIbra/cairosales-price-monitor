/** Shared schema.org JSON-LD extraction, used by both the direct and API fetchers. */

export interface ParsedOffer {
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  raw: unknown;
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

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

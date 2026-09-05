/**
 * How long a mapping's price stays "fresh" before the dashboard marks it stale.
 * The refresh runs daily, so 48h means a price is flagged only after a pass has
 * actually been missed — not merely because it hasn't changed. Shared by the
 * summary SQL and the table cell so both agree on the threshold.
 */
export const STALE_HOURS = 48;

export type FetchMethod = "jsonld" | "selector" | "api";
export type CompetitorType = "retailer" | "manufacturer";
export type MatchStatus = "auto_found" | "confirmed" | "not_found" | "rejected";
export type FetchStatus = "ok" | "not_found" | "error" | "blocked";

export interface TrackedProduct {
  id: string;
  external_ref: string | null;
  model_code: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  our_price: number | null;
  threshold_price: number | null;
  in_stock: boolean;
}

export interface Competitor {
  id: string;
  name: string;
  slug: string;
  type: CompetitorType;
  website_url: string | null;
  fetch_method: FetchMethod;
  search_url_template: string | null;
  config: Record<string, unknown>;
  is_active: boolean;
}

export interface CompetitorProduct {
  id: string;
  tracked_product_id: string;
  competitor_id: string;
  product_url: string | null;
  competitor_sku: string | null;
  match_status: MatchStatus;
  match_confidence: number | null;
}

/** Result of scraping a single competitor product page. */
export interface PriceResult {
  price: number | null;
  currency: string;
  in_stock: boolean | null;
  fetch_status: FetchStatus;
  raw?: unknown;
}

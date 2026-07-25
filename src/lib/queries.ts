import { query } from "./db";
import type { Competitor } from "./types";

export interface ComparisonRow {
  product_id: string;
  model_code: string;
  name: string | null;
  our_price: number | null;
  threshold_price: number | null;
  our_in_stock: boolean;
  competitor_id: string;
  competitor_name: string;
  competitor_slug: string;
  competitor_price: number | null;
  competitor_in_stock: boolean | null;
  below_threshold: boolean | null;
  match_status: string | null;
  product_url: string | null;
  fetch_status: string | null;
  captured_at: string | null;
  delta_pct: number | null;
}

export interface ProductComparison {
  product_id: string;
  model_code: string;
  name: string | null;
  our_price: number | null;
  threshold_price: number | null;
  our_in_stock: boolean;
  cells: Record<string, ComparisonRow>; // keyed by competitor_slug
  cheapest_competitor: string | null;
  cheapest_price: number | null;
  our_rank: number | null; // 1 = we're the cheapest
}

export async function getCompetitors(): Promise<Competitor[]> {
  return query<Competitor>(
    `select id, name, slug, type, website_url, fetch_method, search_url_template, config, is_active
     from competitors where is_active order by type, name`,
  );
}

/** Build the dashboard matrix: one entry per product with a cell per competitor. */
export async function getComparisonMatrix(): Promise<ProductComparison[]> {
  const rows = await query<ComparisonRow>(
    `select * from v_comparison order by model_code, competitor_name`,
  );

  const byProduct = new Map<string, ProductComparison>();
  for (const r of rows) {
    let p = byProduct.get(r.product_id);
    if (!p) {
      p = {
        product_id: r.product_id,
        model_code: r.model_code,
        name: r.name,
        our_price: r.our_price,
        threshold_price: r.threshold_price,
        our_in_stock: r.our_in_stock,
        cells: {},
        cheapest_competitor: null,
        cheapest_price: null,
        our_rank: null,
      };
      byProduct.set(r.product_id, p);
    }
    p.cells[r.competitor_slug] = r;
  }

  for (const p of byProduct.values()) {
    const prices = Object.values(p.cells)
      .filter((c) => c.competitor_price != null)
      .map((c) => ({ slug: c.competitor_slug, price: c.competitor_price as number }));
    if (prices.length) {
      const cheapest = prices.reduce((a, b) => (b.price < a.price ? b : a));
      p.cheapest_competitor = cheapest.slug;
      p.cheapest_price = cheapest.price;
      if (p.our_price != null) {
        const cheaperThanUs = prices.filter((x) => x.price < (p.our_price as number)).length;
        p.our_rank = cheaperThanUs + 1;
      }
    }
  }

  return [...byProduct.values()];
}

export interface HistoryPoint {
  captured_at: string;
  competitor_slug: string;
  competitor_name: string;
  price: number | null;
}

/** Price history for one product across all competitors (for the trend chart). */
export async function getProductHistory(productId: string): Promise<HistoryPoint[]> {
  return query<HistoryPoint>(
    `select s.captured_at, c.slug as competitor_slug, c.name as competitor_name, s.price
     from price_snapshots s
     join competitor_products cp on cp.id = s.competitor_product_id
     join competitors c on c.id = cp.competitor_id
     where cp.tracked_product_id = $1
     order by s.captured_at asc`,
    [productId],
  );
}

import { query } from "./db";
import { STALE_HOURS, type Competitor } from "./types";

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
  /** When the price was last successfully READ (captured_at is when it last MOVED). */
  last_checked_at: string | null;
  delta_pct: number | null;
}

export interface ProductComparison {
  product_id: string;
  model_code: string;
  name: string | null;
  brand: string | null;
  category: string | null;
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

export interface DashboardFilters {
  brand?: string | null;
  category?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
}

export interface DashboardSummary {
  priced: number;
  totalCells: number;
  weAreCheapest: number;
  mapViolations: number;
  /** Priced cells not re-read within STALE_HOURS — the price shown may be held. */
  stale: number;
}

export interface DashboardData {
  products: ProductComparison[];
  total: number; // products matching the filter (not just this page)
  page: number;
  pageSize: number;
  summary: DashboardSummary;
}

// Shared WHERE fragment for the tracked_products filters. $1 brand, $2 category,
// $3 search term (model code or name).
const PRODUCT_FILTER = `is_active
     and ($1::text is null or brand = $1)
     and ($2::text is null or category = $2)
     and ($3::text is null or model_code ilike '%'||$3||'%' or name ilike '%'||$3||'%')`;

/** Distinct brands and categories (with counts) for the filter dropdowns. */
export async function getBrandsAndCategories(): Promise<{
  brands: { name: string; count: number }[];
  categories: { name: string; count: number }[];
}> {
  const [brands, categories] = await Promise.all([
    query<{ name: string; count: number }>(
      `select brand as name, count(*)::int as count from tracked_products
       where is_active and brand is not null group by brand order by brand`,
    ),
    query<{ name: string; count: number }>(
      `select category as name, count(*)::int as count from tracked_products
       where is_active and category is not null group by category order by category`,
    ),
  ]);
  return { brands, categories };
}

/**
 * One page of the comparison matrix, filtered by brand / category / search, with
 * KPI totals computed over the whole filtered set (not just the page). Paginates
 * by product so the dashboard stays fast as the catalog grows to thousands.
 */
export async function getDashboard(f: DashboardFilters): Promise<DashboardData> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = f.pageSize ?? 50;
  const filterParams = [f.brand || null, f.category || null, f.q?.trim() || null];

  const [{ count: total }] = await query<{ count: number }>(
    `select count(*)::int as count from tracked_products where ${PRODUCT_FILTER}`,
    filterParams,
  );

  const idRows = await query<{ product_id: string; brand: string | null; category: string | null }>(
    `select id as product_id, brand, category from tracked_products
     where ${PRODUCT_FILTER}
     order by brand nulls last, model_code
     limit $4 offset $5`,
    [...filterParams, pageSize, (page - 1) * pageSize],
  );
  const ids = idRows.map((r) => r.product_id);

  let products: ProductComparison[] = [];
  if (ids.length) {
    const rows = await query<ComparisonRow>(
      `select * from v_comparison where product_id = any($1) order by model_code, competitor_name`,
      [ids],
    );
    const byProduct = new Map<string, ProductComparison>();
    for (const r of rows) {
      let p = byProduct.get(r.product_id);
      if (!p) {
        p = {
          product_id: r.product_id,
          model_code: r.model_code,
          name: r.name,
          brand: null,
          category: null,
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
    // Preserve the page's sort order and attach brand / category for display.
    products = idRows
      .map((r) => {
        const p = byProduct.get(r.product_id);
        if (!p) return null;
        p.brand = r.brand;
        p.category = r.category;
        return p;
      })
      .filter((p): p is ProductComparison => p !== null);
  }

  const [summary] = await query<{
    priced: number;
    total_cells: number;
    map_violations: number;
    we_are_cheapest: number;
    stale: number;
  }>(
    // STALE_HOURS is our own numeric constant, interpolated because make_interval
    // can't take it from the shared filterParams positional list.
    `with prod as (select id, our_price from tracked_products where ${PRODUCT_FILTER}),
          comp as (
            select v.product_id, v.competitor_price, v.below_threshold, v.last_checked_at
            from v_comparison v where v.product_id in (select id from prod)
          )
     select
       (select count(*)::int from comp where competitor_price is not null) as priced,
       (select count(*)::int from comp) as total_cells,
       (select count(*)::int from comp where below_threshold) as map_violations,
       (select count(*)::int from comp
          where competitor_price is not null
            and (last_checked_at is null
                 or last_checked_at < now() - make_interval(hours => ${STALE_HOURS}))) as stale,
       (select count(*)::int from prod pr
          where pr.our_price is not null
            and exists (select 1 from comp c where c.product_id = pr.id and c.competitor_price is not null)
            and not exists (select 1 from comp c where c.product_id = pr.id and c.competitor_price < pr.our_price)
       ) as we_are_cheapest`,
    filterParams,
  );

  return {
    products,
    total,
    page,
    pageSize,
    summary: {
      priced: summary?.priced ?? 0,
      totalCells: summary?.total_cells ?? 0,
      weAreCheapest: summary?.we_are_cheapest ?? 0,
      mapViolations: summary?.map_violations ?? 0,
      stale: summary?.stale ?? 0,
    },
  };
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

export interface PriceChange {
  competitor_slug: string;
  competitor_name: string;
  website_url: string | null;
  price: number;
  changed_at: string;
}

/**
 * Per-competitor price *changes* for a product: one entry each time the price
 * actually moved (the date it changed to that value), newest first. Consecutive
 * identical prices are collapsed with a window function, so it reads correctly
 * even for history captured before change-only storage. No-price readings are
 * excluded.
 */
export async function getProductPriceChanges(productId: string): Promise<PriceChange[]> {
  return query<PriceChange>(
    `with snaps as (
       select c.slug as competitor_slug, c.name as competitor_name, c.website_url,
              s.price, s.captured_at,
              lag(s.price) over (
                partition by s.competitor_product_id order by s.captured_at
              ) as prev_price,
              row_number() over (
                partition by s.competitor_product_id order by s.captured_at
              ) as rn
       from price_snapshots s
       join competitor_products cp on cp.id = s.competitor_product_id
       join competitors c on c.id = cp.competitor_id and c.is_active
       where cp.tracked_product_id = $1
     )
     select competitor_slug, competitor_name, website_url,
            price, captured_at as changed_at
     from snaps
     where price is not null and (rn = 1 or price is distinct from prev_price)
     order by competitor_name asc, captured_at desc`,
    [productId],
  );
}

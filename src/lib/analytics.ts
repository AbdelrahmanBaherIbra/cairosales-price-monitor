/**
 * Price-position analytics: where we sit against the market, sliced by category,
 * manufacturer and competitor.
 *
 * The unit of analysis is a COMPARABLE PRODUCT — one that has our price AND at
 * least one competitor price. A product nobody else stocks can't be analysed, so
 * it is excluded rather than silently counted as a win (which would flatter every
 * category where we're simply the only seller).
 *
 * "Gap" throughout is measured against the CHEAPEST competitor, not the average:
 * that is the price the customer actually finds when they search for the model.
 *   gap % = (our_price - cheapest) / cheapest * 100
 * Positive = we are more expensive than the cheapest rival (bad).
 * Negative = we undercut the whole market (good, or possibly underpriced).
 *
 * Headline figures use the MEDIAN, not the mean. One accessory where a rival is
 * 300% off distorts a mean badly; the median describes the typical product.
 */
import { query } from "./db";
import { STALE_HOURS } from "./types";

export interface AnalyticsFilters {
  brand?: string | null;
  category?: string | null;
  slug?: string | null;
}

/**
 * Shared CTE prefix for every analytics query. $1 brand, $2 category, $3 slug.
 * `prod` is our side, `cells` is one row per (product, competitor with a price),
 * `per_product` collapses to one row per product, and `cheapest_row` names which
 * competitor is actually cheapest — needed for the action lists.
 */
const BASE = `
  with prod as (
    select tp.id, tp.model_code, tp.name, tp.brand, tp.category, tp.our_price
    from tracked_products tp
    where tp.is_active and tp.our_price is not null and tp.our_price > 0
      and ($1::text is null or tp.brand = $1)
      and ($2::text is null or tp.category = $2)
  ),
  cells as (
    select p.id as product_id, p.brand, p.category, p.our_price,
           c.slug, c.name as competitor_name,
           lp.price, coalesce(lp.below_threshold, false) as below_threshold,
           cp.last_checked_at
    from prod p
    join competitor_products cp on cp.tracked_product_id = p.id
    join competitors c on c.id = cp.competitor_id and c.is_active
    join v_latest_competitor_price lp on lp.competitor_product_id = cp.id
    where lp.price is not null and lp.price > 0
      and ($3::text is null or c.slug = $3)
  ),
  per_product as (
    select product_id, brand, category, our_price,
           min(price) as cheapest,
           avg(price) as avg_comp,
           count(*)::int as comp_count,
           bool_or(below_threshold) as any_map
    from cells group by 1,2,3,4
  ),
  cheapest_row as (
    select distinct on (product_id) product_id, slug, competitor_name, price
    from cells order by product_id, price asc
  )
`;

/** Median gap expression — cast to float8 because percentile_cont needs it. */
const MEDIAN_GAP = (numer: string, denom: string) =>
  `round(percentile_cont(0.5) within group (order by ((${numer} - ${denom}) / ${denom} * 100)::float8)::numeric, 1)`;

const FRESH = `count(*) filter (where last_checked_at > now() - make_interval(hours => ${STALE_HOURS}))::int`;

function params(f: AnalyticsFilters) {
  return [f.brand || null, f.category || null, f.slug || null];
}

export interface CoverageGap {
  with_rival_price: number;
  comparable: number;
  blocked: number;
}

/**
 * How many products we ALREADY have a competitor price for but still can't
 * compare, because our own price is missing or zero. Deliberately not built on
 * BASE, which filters those out — this counts exactly what BASE discards.
 *
 * This is the single biggest limiter on the value of the whole monitor: scraping
 * a rival's price is useless if we don't know our own.
 */
export async function getCoverageGap(f: AnalyticsFilters): Promise<CoverageGap> {
  const [row] = await query<CoverageGap>(
    `select
       count(distinct tp.id)::int as with_rival_price,
       count(distinct tp.id) filter (where coalesce(tp.our_price,0) > 0)::int as comparable,
       count(distinct tp.id) filter (where coalesce(tp.our_price,0) = 0)::int as blocked
     from tracked_products tp
     join competitor_products cp on cp.tracked_product_id = tp.id
     join competitors c on c.id = cp.competitor_id and c.is_active
     join v_latest_competitor_price lp on lp.competitor_product_id = cp.id
     where tp.is_active and lp.price is not null and lp.price > 0
       and ($1::text is null or tp.brand = $1)
       and ($2::text is null or tp.category = $2)
       and ($3::text is null or c.slug = $3)`,
    params(f),
  );
  return row ?? { with_rival_price: 0, comparable: 0, blocked: 0 };
}

export interface AnalyticsSummary {
  products: number;
  we_win: number;
  median_gap_pct: number | null;
  map_breaches: number;
  priced_cells: number;
  fresh_cells: number;
}

export async function getSummary(f: AnalyticsFilters): Promise<AnalyticsSummary> {
  const [row] = await query<AnalyticsSummary>(
    `${BASE}
     select
       count(*)::int as products,
       count(*) filter (where our_price <= cheapest)::int as we_win,
       ${MEDIAN_GAP("our_price", "cheapest")} as median_gap_pct,
       (select count(*)::int from cells where below_threshold) as map_breaches,
       (select count(*)::int from cells) as priced_cells,
       (select ${FRESH} from cells) as fresh_cells
     from per_product`,
    params(f),
  );
  return (
    row ?? {
      products: 0,
      we_win: 0,
      median_gap_pct: null,
      map_breaches: 0,
      priced_cells: 0,
      fresh_cells: 0,
    }
  );
}

export interface SegmentRow {
  segment: string;
  products: number;
  our_avg: number | null;
  cheapest_avg: number | null;
  median_gap_pct: number | null;
  we_win: number;
}

/** Position by one dimension — `category` or `brand`. */
async function getSegment(f: AnalyticsFilters, dim: "category" | "brand"): Promise<SegmentRow[]> {
  return query<SegmentRow>(
    `${BASE}
     select coalesce(${dim}, '(none)') as segment,
            count(*)::int as products,
            round(avg(our_price)) as our_avg,
            round(avg(cheapest)) as cheapest_avg,
            ${MEDIAN_GAP("our_price", "cheapest")} as median_gap_pct,
            count(*) filter (where our_price <= cheapest)::int as we_win
     from per_product
     group by 1
     order by products desc`,
    params(f),
  );
}

export const getByCategory = (f: AnalyticsFilters) => getSegment(f, "category");
export const getByBrand = (f: AnalyticsFilters) => getSegment(f, "brand");

export interface CrossRow {
  brand: string;
  category: string;
  products: number;
  median_gap_pct: number | null;
  we_win: number;
}

/**
 * Brand x category. A brand can look healthy overall while one category bleeds,
 * so this is usually where the actionable story is. Limited to segments with at
 * least 3 comparable products — a median over one product is noise, not a signal.
 */
export async function getCrossTab(f: AnalyticsFilters): Promise<CrossRow[]> {
  return query<CrossRow>(
    `${BASE}
     select coalesce(brand,'(none)') as brand,
            coalesce(category,'(none)') as category,
            count(*)::int as products,
            ${MEDIAN_GAP("our_price", "cheapest")} as median_gap_pct,
            count(*) filter (where our_price <= cheapest)::int as we_win
     from per_product
     group by 1,2
     having count(*) >= 3
     order by count(*) desc
     limit 40`,
    params(f),
  );
}

export interface CompetitorRow {
  slug: string;
  competitor_name: string;
  products_covered: number;
  times_cheaper: number;
  median_gap_pct: number | null;
  map_breaches: number;
  fresh_cells: number;
  cells: number;
}

/** Who actually threatens us: reach, how often they undercut, and by how much. */
export async function getCompetitorScorecard(f: AnalyticsFilters): Promise<CompetitorRow[]> {
  return query<CompetitorRow>(
    `${BASE}
     select slug, competitor_name,
            count(distinct product_id)::int as products_covered,
            count(*) filter (where price < our_price)::int as times_cheaper,
            ${MEDIAN_GAP("our_price", "price")} as median_gap_pct,
            count(*) filter (where below_threshold)::int as map_breaches,
            ${FRESH} as fresh_cells,
            count(*)::int as cells
     from cells
     group by slug, competitor_name
     order by products_covered desc`,
    params(f),
  );
}

export interface OutlierRow {
  id: string;
  model_code: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  our_price: number;
  cheapest: number;
  competitor_name: string;
  gap_pct: number;
}

/**
 * The two action lists. `direction` 'over' = we are most above the cheapest rival
 * (losing the sale); 'under' = we are furthest below it (possibly underpriced).
 */
export async function getOutliers(
  f: AnalyticsFilters,
  direction: "over" | "under",
  limit = 12,
): Promise<OutlierRow[]> {
  return query<OutlierRow>(
    `${BASE}
     select p.id, p.model_code, p.name, p.brand, p.category,
            p.our_price, cr.price as cheapest, cr.competitor_name,
            round((((p.our_price - cr.price) / cr.price) * 100)::numeric, 1) as gap_pct
     from prod p
     join cheapest_row cr on cr.product_id = p.id
     order by gap_pct ${direction === "over" ? "desc" : "asc"}
     limit ${limit}`,
    params(f),
  );
}

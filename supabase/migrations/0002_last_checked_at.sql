-- Freshness: when a mapping's price was last successfully READ.
--
-- price_snapshots is a change log — a row is written only when the price differs
-- from the previous reading — so a snapshot's captured_at is the date the price
-- last MOVED, not the date we last confirmed it. A price that has genuinely held
-- for three months has a three-month-old captured_at even though it was verified
-- this morning. That makes captured_at useless as a freshness signal.
--
-- The dashboard needs to tell two identical-looking cells apart:
--   (a) held  — the site blocked us, the block guard kept the last-known price;
--   (b) stable — we read it today and it simply hasn't changed.
-- last_checked_at is stamped on every successful read, so (a) goes stale and
-- (b) does not.

alter table price_monitor.competitor_products
  add column if not exists last_checked_at timestamptz;

-- Best-effort backfill so existing mappings don't all read as never-verified on
-- first deploy. The latest snapshot is a LOWER BOUND on the last read (the real
-- read may be more recent, since unchanged prices write no row); one refresh
-- pass replaces these with true values.
update price_monitor.competitor_products cp
set last_checked_at = lp.captured_at
from price_monitor.v_latest_competitor_price lp
where lp.competitor_product_id = cp.id
  and cp.last_checked_at is null;

-- Expose it on the comparison view. Dropped and recreated rather than replaced:
-- create or replace can only append columns, and last_checked_at belongs beside
-- the other competitor_products fields.
drop view if exists price_monitor.v_comparison;

create view price_monitor.v_comparison as
select
  tp.id as product_id, tp.model_code, tp.name, tp.our_price, tp.threshold_price,
  tp.in_stock as our_in_stock,
  c.id as competitor_id, c.name as competitor_name, c.slug as competitor_slug, c.type as competitor_type,
  cp.id as competitor_product_id, cp.product_url, cp.match_status, cp.last_checked_at,
  lp.price as competitor_price, lp.in_stock as competitor_in_stock, lp.below_threshold,
  lp.fetch_status, lp.captured_at,
  case when lp.price is null or tp.our_price is null then null
       else round(((lp.price - tp.our_price) / nullif(tp.our_price,0)) * 100, 1) end as delta_pct
from price_monitor.tracked_products tp
cross join price_monitor.competitors c
left join price_monitor.competitor_products cp
  on cp.tracked_product_id = tp.id and cp.competitor_id = c.id
left join price_monitor.v_latest_competitor_price lp
  on lp.competitor_product_id = cp.id
where tp.is_active and c.is_active;

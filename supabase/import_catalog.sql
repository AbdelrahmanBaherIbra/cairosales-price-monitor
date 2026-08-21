-- Ingest Cairo Sales catalog (public.products) into price_monitor.tracked_products,
-- one brand at a time (brand-by-brand rollout). Idempotent: re-running for a brand
-- updates existing rows (matched on model_code = sku) and inserts new ones, so the
-- 69-product Bosch pilot merges in place and keeps its match/price history.
--
-- Usage: replace 'Beko' with the target brand name (public.brands.name_en), or wrap
-- in a client that substitutes it. sku is unique across the catalog, so model_code
-- (its uppercased/trimmed form) stays unique as required by tracked_products.

insert into price_monitor.tracked_products
  (source_product_id, model_code, name, brand, category, our_price, in_stock, is_active)
select p.id, upper(trim(p.sku)), p.product_name_en, b.name_en, cat.name_en, p.price, true, p.is_active
from public.products p
join public.brands b on b.id = p.brand_id
left join public.categories cat on cat.id = p.category_id
where p.is_active and b.name_en = 'Beko'
on conflict (model_code) do update set
  source_product_id = excluded.source_product_id,
  name       = excluded.name,
  brand      = excluded.brand,
  category   = excluded.category,
  our_price  = excluded.our_price,
  is_active  = true;

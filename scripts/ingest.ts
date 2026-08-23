/**
 * Ingest one or more Cairo Sales brands from public.products into
 * price_monitor.tracked_products, so a match run can be dispatched for several
 * brands at once. Idempotent per brand (upsert on model_code), so re-running is
 * safe and merges in place — same logic as supabase/import_catalog.sql.
 *
 * Env:
 *   INGEST_BRANDS   comma-separated brand names (public.brands.name_en), e.g. "LG,Sharp,Fresh"
 */
import { query, closePool } from "../src/lib/db";

// Canonicalize known duplicate brand spellings in the source catalog so a
// re-ingest can't re-split a brand across two names. Maps typo -> real brand.
const BRAND_ALIASES: Record<string, string> = {
  Mianta: "Mienta", // Egyptian small-appliance brand, mostly mis-spelled in the catalog
  "Gleem Gas": "Glem Gas", // Italian gas-cooker brand
};

async function ingestBrand(brand: string): Promise<number> {
  // tracked_products is unqualified (resolves to price_monitor via search_path);
  // the catalog tables are read from the public schema explicitly. The brand
  // column is canonicalized via BRAND_ALIASES so duplicate spellings collapse.
  const canonical = BRAND_ALIASES[brand] ?? brand;
  const rows = await query<{ n: string }>(
    `with ins as (
       insert into tracked_products
         (source_product_id, model_code, name, brand, category, our_price, in_stock, is_active)
       select p.id, upper(trim(p.sku)), p.product_name_en, $2::text, cat.name_en, p.price, true, p.is_active
       from public.products p
       join public.brands b on b.id = p.brand_id
       left join public.categories cat on cat.id = p.category_id
       where p.is_active and b.name_en = $1
       on conflict (model_code) do update set
         source_product_id = excluded.source_product_id,
         name       = excluded.name,
         brand      = excluded.brand,
         category   = excluded.category,
         our_price  = excluded.our_price,
         is_active  = true
       returning 1
     )
     select count(*)::text as n from ins`,
    [brand, canonical],
  );
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  const brands = (process.env.INGEST_BRANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!brands.length) {
    console.log("No INGEST_BRANDS provided; nothing to ingest.");
    return;
  }
  for (const brand of brands) {
    const n = await ingestBrand(brand);
    console.log(`Ingested ${n} products for ${brand}`);
    if (n === 0) console.warn(`  (0 rows — check the brand name matches public.brands.name_en exactly)`);
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool().catch(() => {});
    process.exit(1);
  });

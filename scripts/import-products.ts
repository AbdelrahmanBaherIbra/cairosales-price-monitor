/**
 * Import / upsert tracked products from an Excel or CSV export.
 *
 * Usage:  npx tsx scripts/import-products.ts path/to/BOSCH_HA_Threshold.xlsx
 *
 * Expected columns (as in the Cairo Sales export):
 *   Product ID, Reference code, Pre-tax wholesale price, Threshold Price,
 *   Override Retail Price, Pre-tax retail price, Final price (with-tax),
 *   When out of stock, Quantity
 *
 * "Reference code" is the Bosch model code (the unique match key) and
 * "Final price (with-tax)" is our selling price. Re-running is safe — rows are
 * upserted on model_code.
 */
import * as XLSX from "xlsx";
import { query, closePool } from "../src/lib/db";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx scripts/import-products.ts <file.xlsx|csv>");
    process.exit(1);
  }

  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  let upserted = 0;
  for (const r of rows) {
    const model = String(r["Reference code"] ?? "").trim();
    if (!model) continue;
    const num = (k: string) => {
      const v = r[k];
      const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const qty = num("Quantity");

    await query(
      `insert into tracked_products
         (external_ref, model_code, wholesale_price, threshold_price, retail_price,
          our_price, quantity, in_stock)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (model_code) do update set
         external_ref    = excluded.external_ref,
         wholesale_price = excluded.wholesale_price,
         threshold_price = excluded.threshold_price,
         retail_price    = excluded.retail_price,
         our_price       = excluded.our_price,
         quantity        = excluded.quantity,
         in_stock        = excluded.in_stock`,
      [
        r["Product ID"] != null ? String(r["Product ID"]).trim() : null,
        model,
        num("Pre-tax wholesale price"),
        num("Threshold Price"),
        num("Pre-tax retail price"),
        num("Final price (with-tax)"),
        qty,
        qty != null && qty > 0,
      ],
    );
    upserted++;
  }

  console.log(`Upserted ${upserted} products.`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

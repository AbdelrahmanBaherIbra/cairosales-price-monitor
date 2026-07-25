import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { findByModelCode } from "@/lib/match/modelCode";
import type { Competitor } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Model-code matcher. For a given competitor (?slug=btech), searches that site
 * for each tracked product's Bosch model code and stores the best candidate URL
 * as an "auto_found" mapping for a human to confirm.
 *
 * POST /api/match?slug=btech   (Bearer CRON_SECRET)
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug query param required" }, { status: 400 });

  const competitors = await query<Competitor>(
    `select * from competitors where slug = $1 and is_active`,
    [slug],
  );
  const competitor = competitors[0];
  if (!competitor) return NextResponse.json({ error: "competitor not found" }, { status: 404 });

  const products = await query<{ id: string; model_code: string }>(
    `select id, model_code from tracked_products where is_active`,
  );

  let found = 0;
  for (const p of products) {
    const candidate = await findByModelCode(competitor, p.model_code);
    if (!candidate) continue;
    found++;
    await query(
      `insert into competitor_products
         (tracked_product_id, competitor_id, product_url, match_status, match_confidence)
       values ($1,$2,$3,'auto_found',$4)
       on conflict (tracked_product_id, competitor_id)
       do update set product_url = excluded.product_url,
                     match_confidence = excluded.match_confidence,
                     match_status = case
                       when competitor_products.match_status = 'confirmed'
                       then 'confirmed' else 'auto_found' end`,
      [p.id, competitor.id, candidate.url, candidate.confidence],
    );
    await sleep(500);
  }

  return NextResponse.json({ ok: true, competitor: slug, scanned: products.length, found });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

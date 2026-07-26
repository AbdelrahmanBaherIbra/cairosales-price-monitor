import { query } from "./db";
import { fetchPrice } from "./fetchers";
import { mapPool } from "./pool";
import type { Competitor } from "./types";

interface Job {
  competitor_product_id: string;
  product_url: string;
  threshold_price: number | null;
  competitor: Competitor;
}

export interface RefreshSummary {
  attempted: number;
  ok: number;
  not_found: number;
  blocked: number;
  error: number;
}

/**
 * The daily job. Walks every confirmed/auto-found competitor_product that has a
 * URL, fetches its current price, and appends a snapshot (append-only history).
 * Flags below_threshold when a competitor undercuts the Bosch minimum (MAP).
 *
 * Runs with bounded concurrency so a few hundred products finish within
 * Vercel's function time limit. An optional slug restricts the run to one
 * competitor (handy for a first pilot run).
 */
export async function runRefresh(slug?: string): Promise<RefreshSummary> {
  const jobs = await query<Job & Record<string, unknown>>(
    `select cp.id as competitor_product_id,
            cp.product_url,
            tp.threshold_price,
            row_to_json(c.*) as competitor
     from competitor_products cp
     join tracked_products tp on tp.id = cp.tracked_product_id
     join competitors c on c.id = cp.competitor_id
     where cp.product_url is not null
       and cp.match_status in ('auto_found','confirmed')
       and c.is_active and tp.is_active
       and ($1::text is null or c.slug = $1)`,
    [slug ?? null],
  );

  const summary: RefreshSummary = { attempted: 0, ok: 0, not_found: 0, blocked: 0, error: 0 };

  await mapPool(jobs, 4, async (job) => {
    summary.attempted++;
    const result = await fetchPrice(job.competitor as Competitor, job.product_url as string);
    const belowThreshold =
      result.price != null && job.threshold_price != null
        ? result.price < Number(job.threshold_price)
        : null;

    await query(
      `insert into price_snapshots
         (competitor_product_id, price, currency, in_stock, below_threshold, fetch_status, raw)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        job.competitor_product_id,
        result.price,
        result.currency,
        result.in_stock,
        belowThreshold,
        result.fetch_status,
        result.raw ? JSON.stringify(result.raw) : null,
      ],
    );

    if (result.fetch_status === "ok") summary.ok++;
    else if (result.fetch_status === "not_found") summary.not_found++;
    else if (result.fetch_status === "blocked") summary.blocked++;
    else summary.error++;
  });

  return summary;
}

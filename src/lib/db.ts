import { Pool, types } from "pg";

/**
 * Parse Postgres `numeric`/`decimal` (type OID 1700) as a JS number instead of
 * the driver's default string. Prices are stored as numeric, and leaving them
 * as strings makes every `price < our_price` comparison lexicographic
 * ("11969" < "9499" is true because '1' < '9'), which mis-colours cells and
 * corrupts the rank / cheapest calculations. Numbers here fix all of it.
 */
types.setTypeParser(1700, (val) => (val === null ? null : Number(val)));

/**
 * Server-only Postgres pool for the Cairo Sales database.
 *
 * We connect directly (not via Supabase REST) because the price_monitor schema
 * is intentionally NOT exposed to the API — this keeps competitor pricing off
 * the public surface entirely. Use the Supabase transaction pooler URL on
 * serverless. search_path is pinned so unqualified names resolve to our schema.
 *
 * The pool is created lazily on first query so importing this module (e.g.
 * during `next build` page-data collection) never requires env vars.
 */
declare global {
  // eslint-disable-next-line no-var
  var _pmPool: Pool | undefined;
}

function getPool(): Pool {
  if (global._pmPool) return global._pmPool;
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("Missing required env var: SUPABASE_DB_URL");
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 3,
    options: "-c search_path=price_monitor,public",
  });
  global._pmPool = pool;
  return pool;
}

/**
 * Transient connection failures — the pooled connection died or the Supabase
 * transaction pooler was briefly unreachable. These are safe to retry on a fresh
 * pool client; the failed statement never committed (pg discards the broken
 * client on error). We deliberately do NOT retry logical errors (bad SQL,
 * constraint violations) — those would just fail again.
 *
 *   08xxx  connection exceptions (08006 connection_failure, 08001/08003/08004…)
 *   57P01/57P02/57P03  server shut down / terminated / not accepting connections
 *   EAUTHTIMEOUT       pg-pool "timeout while waiting for message" (no SQLSTATE)
 *   ECONNRESET/EPIPE/ETIMEDOUT  socket dropped mid-flight
 */
function isTransientDbError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? "";
  if (/^08/.test(code) || code === "57P01" || code === "57P02" || code === "57P03") return true;
  if (["ECONNRESET", "EPIPE", "ETIMEDOUT", "EAUTHTIMEOUT"].includes(code)) return true;
  return /EAUTHTIMEOUT|timeout while waiting for message|Connection terminated|ECONNRESET/i.test(
    e?.message ?? "",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a query, retrying transient connection drops with exponential backoff.
 * A single pooler blip during a 20–90-minute scrape run should not fail the
 * whole job; logical errors still throw immediately.
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const MAX_ATTEMPTS = 4; // ~1s, 2s, 4s backoff between the 4 tries
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await getPool().query(text, params as never[]);
      return res.rows as T[];
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS || !isTransientDbError(err)) throw err;
      const backoff = 1000 * 2 ** (attempt - 1);
      const msg = (err as { message?: string })?.message ?? String(err);
      console.warn(`DB query failed (${msg}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** For scripts that need to close the connection explicitly. */
export async function closePool(): Promise<void> {
  if (global._pmPool) {
    await global._pmPool.end();
    global._pmPool = undefined;
  }
}

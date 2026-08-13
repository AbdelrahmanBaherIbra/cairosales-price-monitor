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

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

/** For scripts that need to close the connection explicitly. */
export async function closePool(): Promise<void> {
  if (global._pmPool) {
    await global._pmPool.end();
    global._pmPool = undefined;
  }
}

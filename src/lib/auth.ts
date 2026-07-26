/**
 * Authorize an admin/cron request. Accepts the secret either as
 *   Authorization: Bearer <CRON_SECRET>        (used by Vercel Cron / curl)
 * or as a ?token=<CRON_SECRET> query param      (so it can be triggered by just
 *                                                opening a URL in a browser).
 *
 * Query-param auth is a convenience for manual, mobile triggering of an internal
 * tool. The secret can be rotated anytime via the CRON_SECRET env var.
 */
export function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured (local dev) -> allow
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const token = new URL(req.url).searchParams.get("token");
  return token === secret;
}

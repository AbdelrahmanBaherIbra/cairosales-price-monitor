import { NextResponse } from "next/server";
import { runRefresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // scraping can be slow; allow up to 5 min

/**
 * Daily price refresh. Triggered by Vercel Cron (see vercel.json) once a day.
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Can also be invoked
 * manually with the same header for an on-demand run.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runRefresh();
    return NextResponse.json({ success: true, ...summary, ranAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

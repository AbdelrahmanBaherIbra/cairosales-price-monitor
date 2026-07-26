import { NextResponse } from "next/server";
import { runRefresh } from "@/lib/refresh";
import { isAuthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily price refresh. Triggered by Vercel Cron (see vercel.json) once a day.
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or `?token=$CRON_SECRET`
 * (manual browser trigger). Can be invoked on-demand for an immediate run.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
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

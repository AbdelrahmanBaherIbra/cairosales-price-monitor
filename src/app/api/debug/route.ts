import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";
import { extractOfferFromHtml } from "@/lib/fetchers/html";
import { mapPool } from "@/lib/pool";
import type { Competitor } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Diagnostic: for one model code, fetch each competitor's SEARCH page and report
 * what a plain server-side fetch actually sees. Tells us which sites are
 * server-rendered (usable now) vs JS-rendered / blocked (need the scraping API).
 *
 *   /api/debug?token=$CRON_SECRET&code=KGN56LB3E9
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const code = new URL(req.url).searchParams.get("code") ?? "KGN56LB3E9";

  const competitors = await query<Competitor>(
    `select * from competitors where is_active and search_url_template is not null order by slug`,
  );

  const results = await mapPool(competitors, 5, async (c) => {
    const url = c.search_url_template!.replace("{query}", encodeURIComponent(code));
    const started = Date.now();
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(t);
      const html = await res.text();
      const norm = html.toLowerCase().replace(/[^a-z0-9]/g, "");
      const codeNorm = code.toLowerCase().replace(/[^a-z0-9]/g, "");
      const productLinks = [...html.matchAll(/href=["']([^"']+)["']/gi)]
        .map((m) => m[1])
        .filter((h) => /\/(p|product|products|item|dp)\//i.test(h) || /-p-?\d/i.test(h));
      return {
        slug: c.slug,
        method: c.fetch_method,
        status: res.status,
        htmlKb: Math.round(html.length / 1024),
        jsonldBlocks: (html.match(/application\/ld\+json/gi) || []).length,
        hasProductJsonLd: !!extractOfferFromHtml(html),
        productLinks: productLinks.length,
        codeSeenInHtml: norm.includes(codeNorm),
        ms: Date.now() - started,
      };
    } catch (err) {
      return {
        slug: c.slug,
        method: c.fetch_method,
        status: "fetch_failed",
        error: err instanceof Error ? err.name : String(err),
        ms: Date.now() - started,
      };
    }
  });

  return NextResponse.json({ code, competitors: results });
}

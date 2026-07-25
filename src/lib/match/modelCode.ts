import type { Competitor } from "@/lib/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface MatchCandidate {
  url: string;
  confidence: number; // 0..1
}

/**
 * Find a competitor's product URL for a Bosch model code.
 *
 * Bosch reference codes (e.g. KGN56LB3E9) are globally unique and appear in
 * competitor product titles/URLs, so a site search for the code is a strong
 * signal. We hit the competitor's `search_url_template` and take the first
 * product link whose URL/text contains the (normalised) code.
 *
 * Returns the best candidate or null. Human confirmation flips match_status to
 * "confirmed"; this only proposes.
 */
export async function findByModelCode(
  competitor: Competitor,
  modelCode: string,
): Promise<MatchCandidate | null> {
  if (!competitor.search_url_template) return null;
  const query = normalise(modelCode);
  const searchUrl = competitor.search_url_template.replace(
    "{query}",
    encodeURIComponent(modelCode),
  );

  let html: string;
  try {
    const res = await fetch(searchUrl, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const links = extractProductLinks(html, competitor.website_url ?? "");
  // Strongest signal: the model code appears in the link URL itself.
  const inUrl = links.find((l) => normalise(l).includes(query));
  if (inUrl) return { url: inUrl, confidence: 0.9 };

  // Weaker: code appears near a link in the page text.
  if (normalise(html).includes(query) && links.length > 0) {
    return { url: links[0], confidence: 0.5 };
  }
  return null;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractProductLinks(html: string, base: string): string[] {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const abs = hrefs
    .map((h) => toAbsolute(h, base))
    .filter((h): h is string => !!h)
    .filter((h) => /\/(p|product|products|item|dp)\//i.test(h) || /-p-?\d/i.test(h));
  return [...new Set(abs)];
}

function toAbsolute(href: string, base: string): string | null {
  try {
    if (href.startsWith("http")) return href;
    if (!base) return null;
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

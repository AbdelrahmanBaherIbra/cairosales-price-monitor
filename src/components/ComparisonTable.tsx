import Link from "next/link";
import { STALE_HOURS, type Competitor } from "@/lib/types";
import type { ProductComparison } from "@/lib/queries";
import { RetailerLogo } from "@/components/RetailerLogo";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(n);
}

export function ComparisonTable({
  products,
  competitors,
  showBrand = false,
}: {
  products: ProductComparison[];
  competitors: Competitor[];
  showBrand?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="model">Model</th>
            <th>Our price</th>
            <th>Threshold</th>
            <th>Rank</th>
            {competitors.map((c) => (
              <th key={c.slug}>
                <span className="colhead">
                  <RetailerLogo name={c.name} websiteUrl={c.website_url} />
                  {c.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.product_id}>
              <td className="model">
                <Link href={`/product/${p.product_id}`}>{p.model_code}</Link>
                {showBrand && p.brand ? <span className="brand-tag">{p.brand}</span> : null}
              </td>
              <td className="our">{fmt(p.our_price)}</td>
              <td className="muted">{fmt(p.threshold_price)}</td>
              <td>
                {p.our_rank != null ? (
                  <span className="pill">
                    {p.our_rank === 1 ? "cheapest" : `#${p.our_rank}`}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              {competitors.map((c) => {
                const cell = p.cells[c.slug];
                const price = cell?.competitor_price ?? null;
                const stale = price != null && isStale(cell?.last_checked_at);
                const cls = [
                  price == null || p.our_price == null
                    ? ""
                    : cell?.below_threshold
                      ? "map-flag"
                      : price < p.our_price
                        ? "cheaper"
                        : price > p.our_price
                          ? "pricier"
                          : "",
                  stale ? "stale" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const title = statusTitle(cell);
                return (
                  <td key={c.slug} className={cls} title={title}>
                    {price != null ? (
                      <>
                        {cell?.product_url ? (
                          <a href={cell.product_url} target="_blank" rel="noreferrer">
                            {fmt(price)}
                          </a>
                        ) : (
                          fmt(price)
                        )}
                        {stale ? (
                          <span className="age">{ageLabel(cell?.last_checked_at ?? null)}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">{shortStatus(cell)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shortStatus(cell?: { match_status: string | null; fetch_status: string | null }): string {
  if (!cell || !cell.match_status) return "·";
  if (cell.match_status === "not_found") return "no match";
  if (cell.fetch_status === "blocked") return "blocked";
  if (cell.fetch_status === "error") return "err";
  if (cell.fetch_status === "not_found") return "no price";
  return "—";
}

/**
 * A price is stale when we haven't successfully re-read it within STALE_HOURS.
 * Null means never verified since freshness tracking was added, which is also
 * stale — we can't vouch for a number we have no read on. This is the only thing
 * separating a price the block guard is holding from one that simply hasn't moved.
 */
function isStale(lastCheckedAt: string | null | undefined): boolean {
  if (!lastCheckedAt) return true;
  return Date.now() - new Date(lastCheckedAt).getTime() > STALE_HOURS * 3_600_000;
}

/** Compact age marker on a stale cell: "3d" since the last read, "?" if never read. */
function ageLabel(lastCheckedAt: string | null): string {
  if (!lastCheckedAt) return "?";
  const days = Math.floor((Date.now() - new Date(lastCheckedAt).getTime()) / 86_400_000);
  return days >= 1 ? `${days}d` : "!";
}

function statusTitle(cell?: {
  match_status: string | null;
  fetch_status: string | null;
  captured_at: string | null;
  last_checked_at: string | null;
}): string {
  if (!cell) return "";
  const parts: string[] = [];
  if (cell.match_status) parts.push(`match: ${cell.match_status}`);
  if (cell.fetch_status) parts.push(`fetch: ${cell.fetch_status}`);
  // Two different dates, deliberately labelled apart: when the price last moved
  // vs when we last confirmed it. Equal only when the last read found a change.
  if (cell.captured_at) parts.push(`price set ${new Date(cell.captured_at).toLocaleDateString()}`);
  parts.push(
    cell.last_checked_at
      ? `last checked ${new Date(cell.last_checked_at).toLocaleString()}`
      : "never re-checked",
  );
  return parts.join(" · ");
}

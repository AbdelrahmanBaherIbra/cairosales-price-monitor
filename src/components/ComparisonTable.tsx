import Link from "next/link";
import type { Competitor } from "@/lib/types";
import type { ProductComparison } from "@/lib/queries";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(n);
}

export function ComparisonTable({
  products,
  competitors,
}: {
  products: ProductComparison[];
  competitors: Competitor[];
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
              <th key={c.slug}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.product_id}>
              <td className="model">
                <Link href={`/product/${p.product_id}`}>{p.model_code}</Link>
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
                const cls =
                  price == null || p.our_price == null
                    ? ""
                    : cell?.below_threshold
                      ? "map-flag"
                      : price < p.our_price
                        ? "cheaper"
                        : price > p.our_price
                          ? "pricier"
                          : "";
                const title = statusTitle(cell);
                return (
                  <td key={c.slug} className={cls} title={title}>
                    {price != null ? (
                      cell?.product_url ? (
                        <a href={cell.product_url} target="_blank" rel="noreferrer">
                          {fmt(price)}
                        </a>
                      ) : (
                        fmt(price)
                      )
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

function statusTitle(cell?: {
  match_status: string | null;
  fetch_status: string | null;
  captured_at: string | null;
}): string {
  if (!cell) return "";
  const parts: string[] = [];
  if (cell.match_status) parts.push(`match: ${cell.match_status}`);
  if (cell.fetch_status) parts.push(`fetch: ${cell.fetch_status}`);
  if (cell.captured_at) parts.push(`as of ${new Date(cell.captured_at).toLocaleString()}`);
  return parts.join(" · ");
}

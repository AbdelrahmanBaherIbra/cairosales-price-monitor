import { RetailerLogo } from "@/components/RetailerLogo";
import type { PriceChange } from "@/lib/queries";

function fmtPrice(n: number): string {
  return new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(n);
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface Group {
  slug: string;
  name: string;
  website: string | null;
  items: PriceChange[];
}

/**
 * Each competitor's price(s) for this product, with the date each price took
 * effect. Competitors with more than one price show the full change timeline
 * (newest first); a single price just shows since when it has held.
 */
export function PriceChanges({ changes }: { changes: PriceChange[] }) {
  const groups = new Map<string, Group>();
  for (const c of changes) {
    let g = groups.get(c.competitor_slug);
    if (!g) {
      g = { slug: c.competitor_slug, name: c.competitor_name, website: c.website_url, items: [] };
      groups.set(c.competitor_slug, g);
    }
    g.items.push(c); // query already returns newest-first within each competitor
  }

  if (groups.size === 0) {
    return (
      <section className="changes">
        <h2>Prices by competitor</h2>
        <p className="muted">No competitor prices recorded yet for this product.</p>
      </section>
    );
  }

  return (
    <section className="changes">
      <h2>Prices by competitor</h2>
      <p className="sub">Each price and the date it changed. Competitors with more than one entry have changed price over time.</p>
      <div className="change-grid">
        {[...groups.values()].map((g) => (
          <div className="change-card" key={g.slug}>
            <div className="change-head">
              <RetailerLogo name={g.name} websiteUrl={g.website} />
              <span className="cname">{g.name}</span>
              {g.items.length > 1 && (
                <span className="chg-count">{g.items.length} prices</span>
              )}
            </div>
            <ol className="change-list">
              {g.items.map((it, i) => (
                <li key={i} className={i === 0 ? "current" : ""}>
                  <span className="chg-price">{fmtPrice(it.price)}</span>
                  <span className="chg-date">
                    {g.items.length > 1 && i === 0 ? "since " : ""}
                    {fmtDate(it.changed_at)}
                  </span>
                  {i === 0 && g.items.length > 1 && <span className="chg-tag">current</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

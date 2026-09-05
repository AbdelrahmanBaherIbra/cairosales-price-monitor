import Link from "next/link";
import { getDashboard, getBrandsAndCategories, getCompetitors } from "@/lib/queries";
import { ComparisonTable } from "@/components/ComparisonTable";
import { BrandBar } from "@/components/BrandBar";
import { STALE_HOURS } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 50;

type SP = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const brand = one(sp.brand);
  const category = one(sp.category);
  const q = one(sp.q);
  const page = Math.max(1, Number(one(sp.page) ?? "1") || 1);

  const [data, opts, competitors] = await Promise.all([
    getDashboard({ brand, category, q, page, pageSize: PAGE_SIZE }),
    getBrandsAndCategories(),
    getCompetitors(),
  ]);

  const { products, total, summary } = data;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  // Build a URL preserving the active filters, overriding given keys.
  const href = (over: Record<string, string | number | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | number | null> = { brand, category, q, ...over };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && String(v).length) params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const filtered = brand || category || q;

  return (
    <main className="wrap">
      <BrandBar
        title="Competitor Price Monitor"
        tag={`${total} products · ${competitors.length} retailers`}
      />

      <form className="filters" method="get" action="/">
        <select name="brand" defaultValue={brand ?? ""} aria-label="Brand">
          <option value="">All brands</option>
          {opts.brands.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name} ({b.count})
            </option>
          ))}
        </select>
        <select name="category" defaultValue={category ?? ""} aria-label="Category">
          <option value="">All categories</option>
          {opts.categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search model or name…"
          aria-label="Search"
        />
        <button type="submit">Filter</button>
        {filtered ? (
          <Link className="clear" href="/">
            Clear
          </Link>
        ) : null}
      </form>

      <section className="cards">
        <Card k="Products (filtered)" v={String(total)} />
        <Card k="Prices captured" v={`${summary.priced} / ${summary.totalCells}`} />
        <Card k="We are cheapest" v={String(summary.weAreCheapest)} accent />
        <Card k="Below MAP threshold" v={String(summary.mapViolations)} />
        <Card k={`Stale (>${STALE_HOURS}h)`} v={String(summary.stale)} />
      </section>

      {products.length === 0 ? (
        <p className="muted">No products match these filters.</p>
      ) : (
        <>
          <ComparisonTable products={products} competitors={competitors} showBrand={!brand} />

          <nav className="pager">
            <span className="muted">
              Showing {from}–{to} of {total}
            </span>
            <span className="pager-controls">
              {page > 1 ? (
                <Link href={href({ page: page - 1 })}>← Prev</Link>
              ) : (
                <span className="disabled">← Prev</span>
              )}
              <span className="muted">
                Page {page} / {pages}
              </span>
              {page < pages ? (
                <Link href={href({ page: page + 1 })}>Next →</Link>
              ) : (
                <span className="disabled">Next →</span>
              )}
            </span>
          </nav>
        </>
      )}

      <div className="legend">
        <span><span className="dot" style={{ background: "var(--red)" }} />competitor cheaper than us (undercutting)</span>
        <span><span className="dot" style={{ background: "var(--green)" }} />competitor pricier than us (we win)</span>
        <span><span className="dot" style={{ background: "var(--amber)" }} />below manufacturer MAP threshold</span>
        <span><span className="dot" style={{ background: "var(--muted)", opacity: .48 }} />dimmed = not re-checked in {STALE_HOURS}h, price may be held</span>
      </div>
    </main>
  );
}

function Card({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className={accent ? "card accent" : "card"}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

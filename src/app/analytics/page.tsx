import Link from "next/link";
import { BrandBar } from "@/components/BrandBar";
import { getBrandsAndCategories, getCompetitors } from "@/lib/queries";
import {
  getSummary,
  getByCategory,
  getByBrand,
  getCrossTab,
  getCompetitorScorecard,
  getOutliers,
  getCoverageGap,
  type SegmentRow,
  type OutlierRow,
} from "@/lib/analytics";
import { STALE_HOURS } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SP = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
}

const num = (n: number | null | undefined, dp = 0) =>
  n == null ? "—" : new Intl.NumberFormat("en-EG", { maximumFractionDigits: dp }).format(n);

const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/**
 * Gap against the cheapest competitor, drawn from a centre line: right/red means
 * we are more expensive than the cheapest rival, left/green means we undercut the
 * market. Capped at ±30% so one extreme product can't flatten every other bar.
 */
function GapBar({ value }: { value: number | null }) {
  if (value == null) return <span className="muted">—</span>;
  const capped = Math.max(-30, Math.min(30, value));
  const width = (Math.abs(capped) / 30) * 50;
  const over = value > 0;
  return (
    <span className="gapbar" aria-hidden="true">
      <span className="gapbar-mid" />
      <span
        className={over ? "gapbar-fill over" : "gapbar-fill under"}
        style={over ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
      />
    </span>
  );
}

function SegmentTable({ rows, label }: { rows: SegmentRow[]; label: string }) {
  if (!rows.length) return <p className="muted">No comparable products in this slice.</p>;
  return (
    <div className="table-scroll">
      <table className="analytics">
        <thead>
          <tr>
            <th className="left">{label}</th>
            <th>Products</th>
            <th>Our avg</th>
            <th>Cheapest rival avg</th>
            <th>Median gap</th>
            <th className="barcol">vs market</th>
            <th>We win</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const winRate = r.products ? Math.round((r.we_win / r.products) * 100) : 0;
            return (
              <tr key={r.segment}>
                <td className="left strong">{r.segment}</td>
                <td>{num(r.products)}</td>
                <td>{num(r.our_avg)}</td>
                <td>{num(r.cheapest_avg)}</td>
                <td className={r.median_gap_pct == null ? "" : r.median_gap_pct > 0 ? "neg" : "pos"}>
                  {pct(r.median_gap_pct)}
                </td>
                <td className="barcol">
                  <GapBar value={r.median_gap_pct} />
                </td>
                <td>
                  <span className="pill">
                    {r.we_win}/{r.products} · {winRate}%
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OutlierTable({ rows, kind }: { rows: OutlierRow[]; kind: "over" | "under" }) {
  if (!rows.length) return <p className="muted">Nothing to show in this slice.</p>;
  return (
    <div className="table-scroll">
      <table className="analytics">
        <thead>
          <tr>
            <th className="left">Model</th>
            <th className="left">Category</th>
            <th>Our price</th>
            <th>Cheapest rival</th>
            <th className="left">Who</th>
            <th>Gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="left strong">
                <Link href={`/product/${r.id}`}>{r.model_code}</Link>
                <span className="brand-tag">{r.brand}</span>
              </td>
              <td className="left muted">{r.category ?? "—"}</td>
              <td>{num(r.our_price)}</td>
              <td>{num(r.cheapest)}</td>
              <td className="left">{r.competitor_name}</td>
              <td className={kind === "over" ? "neg strong" : "pos strong"}>{pct(r.gap_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const brand = one(sp.brand);
  const category = one(sp.category);
  const slug = one(sp.slug);
  const f = { brand, category, slug };

  const [summary, gap, byCategory, byBrand, cross, scorecard, over, under, opts, competitors] =
    await Promise.all([
      getSummary(f),
      getCoverageGap(f),
      getByCategory(f),
      getByBrand(f),
      getCrossTab(f),
      getCompetitorScorecard(f),
      getOutliers(f, "over"),
      getOutliers(f, "under"),
      getBrandsAndCategories(),
      getCompetitors(),
    ]);

  const winRate = summary.products ? Math.round((summary.we_win / summary.products) * 100) : 0;
  const freshRate = summary.priced_cells
    ? Math.round((summary.fresh_cells / summary.priced_cells) * 100)
    : 0;

  return (
    <main className="wrap">
      <BrandBar
        title="Price Analytics"
        tag={`${summary.products} comparable products · ${summary.priced_cells} competitor prices`}
        back
      />

      <form className="filters" method="get" action="/analytics">
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
        <select name="slug" defaultValue={slug ?? ""} aria-label="Competitor">
          <option value="">All competitors</option>
          {competitors.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit">Analyse</button>
        {brand || category || slug ? (
          <Link className="clear" href="/analytics">
            Clear
          </Link>
        ) : null}
      </form>

      {gap.blocked > 0 ? (
        <div className="gap-warn">
          <h3>
            {num(gap.blocked)} products have a competitor price but no price of ours
          </h3>
          <p>
            We are successfully tracking rivals on <strong>{num(gap.with_rival_price)}</strong>{" "}
            products, but only <strong>{num(gap.comparable)}</strong> can be analysed — the rest have
            no selling price of ours to compare against, so there is no gap to compute, no rank and
            no MAP check.
          </p>
          <p>
            This is not a scraping problem and nothing on this page can fix it. The prices come from
            the Cairo Sales catalog (<code>products.price</code>), where they are currently zero.
            Fill those in and {num(gap.blocked)} more products become comparable immediately — no
            re-matching, no re-scraping, the competitor prices are already captured and waiting.
          </p>
        </div>
      ) : null}

      {freshRate < 80 ? (
        <div className="freshness-warn">
          <strong>{freshRate}% of these prices were verified in the last {STALE_HOURS}h.</strong>{" "}
          The rest are the last known values — the analysis below describes the market as it was
          when those prices were last read, not necessarily today.
        </div>
      ) : null}

      <section className="cards">
        <Card k="Comparable products" v={num(summary.products)} />
        <Card k="We are cheapest" v={`${winRate}%`} accent />
        <Card k="Median gap vs cheapest" v={pct(summary.median_gap_pct)} />
        <Card k="Below MAP threshold" v={num(summary.map_breaches)} />
      </section>

      <p className="explainer">
        Gap is measured against the <strong>cheapest</strong> competitor carrying that model — the
        price a customer finds when they search for it. A <span className="neg">positive</span> gap
        means we are more expensive than the cheapest rival; a <span className="pos">negative</span>{" "}
        gap means we undercut the whole market. Medians are used throughout, so one extreme product
        can&apos;t distort a segment. Products no competitor stocks are excluded — they can&apos;t be
        compared, and counting them would flatter every number on this page.
      </p>

      <h2 className="sec">Position by category</h2>
      <SegmentTable rows={byCategory} label="Category" />

      <h2 className="sec">Position by manufacturer</h2>
      <SegmentTable rows={byBrand} label="Brand" />

      <h2 className="sec">Manufacturer × category</h2>
      <p className="sub">
        Segments with at least 3 comparable products. This is usually where the real story is — a
        brand can look healthy overall while one of its categories is losing badly.
      </p>
      {cross.length ? (
        <div className="table-scroll">
          <table className="analytics">
            <thead>
              <tr>
                <th className="left">Brand</th>
                <th className="left">Category</th>
                <th>Products</th>
                <th>Median gap</th>
                <th className="barcol">vs market</th>
                <th>We win</th>
              </tr>
            </thead>
            <tbody>
              {cross.map((r) => (
                <tr key={`${r.brand}|${r.category}`}>
                  <td className="left strong">{r.brand}</td>
                  <td className="left">{r.category}</td>
                  <td>{num(r.products)}</td>
                  <td className={r.median_gap_pct == null ? "" : r.median_gap_pct > 0 ? "neg" : "pos"}>
                    {pct(r.median_gap_pct)}
                  </td>
                  <td className="barcol">
                    <GapBar value={r.median_gap_pct} />
                  </td>
                  <td>
                    <span className="pill">
                      {r.we_win}/{r.products}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No segment has 3 or more comparable products in this slice.</p>
      )}

      <h2 className="sec">Competitor scorecard</h2>
      <p className="sub">
        Who actually threatens us: how many of our products they carry, how often they undercut us,
        and by how much.
      </p>
      <div className="table-scroll">
        <table className="analytics">
          <thead>
            <tr>
              <th className="left">Competitor</th>
              <th>Products carried</th>
              <th>Undercuts us</th>
              <th>Median gap</th>
              <th className="barcol">vs market</th>
              <th>MAP breaches</th>
              <th>Fresh prices</th>
            </tr>
          </thead>
          <tbody>
            {scorecard.map((r) => (
              <tr key={r.slug}>
                <td className="left strong">{r.competitor_name}</td>
                <td>{num(r.products_covered)}</td>
                <td>
                  <span className="pill">
                    {r.times_cheaper}/{r.cells} ·{" "}
                    {r.cells ? Math.round((r.times_cheaper / r.cells) * 100) : 0}%
                  </span>
                </td>
                <td className={r.median_gap_pct == null ? "" : r.median_gap_pct > 0 ? "neg" : "pos"}>
                  {pct(r.median_gap_pct)}
                </td>
                <td className="barcol">
                  <GapBar value={r.median_gap_pct} />
                </td>
                <td>{num(r.map_breaches)}</td>
                <td className={r.fresh_cells === 0 ? "muted" : ""}>
                  {r.cells ? Math.round((r.fresh_cells / r.cells) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="sec">Where we are losing</h2>
      <p className="sub">
        Biggest gaps above the cheapest rival — the models a price-checking customer buys elsewhere.
      </p>
      <OutlierTable rows={over} kind="over" />

      <h2 className="sec">Where we may be leaving money</h2>
      <p className="sub">
        Furthest below the cheapest rival. Deliberate on loss-leaders — worth a look on everything
        else.
      </p>
      <OutlierTable rows={under} kind="under" />
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

import { getComparisonMatrix, getCompetitors } from "@/lib/queries";
import { ComparisonTable } from "@/components/ComparisonTable";
import { BrandBar } from "@/components/BrandBar";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  const [products, competitors] = await Promise.all([
    getComparisonMatrix(),
    getCompetitors(),
  ]);

  const totalCells = products.length * competitors.length;
  const priced = products.reduce(
    (acc, p) => acc + Object.values(p.cells).filter((c) => c.competitor_price != null).length,
    0,
  );
  const mapViolations = products.reduce(
    (acc, p) => acc + Object.values(p.cells).filter((c) => c.below_threshold).length,
    0,
  );
  const weAreCheapest = products.filter((p) => p.our_rank === 1).length;

  return (
    <main className="wrap">
      <BrandBar
        title="Competitor Price Monitor"
        tag={`Bosch pilot · ${products.length} products · ${competitors.length} competitors`}
      />
      <p className="sub">Prices refresh once daily. Click a model for its price history.</p>

      <section className="cards">
        <Card k="Products" v={String(products.length)} />
        <Card k="Prices captured" v={`${priced} / ${totalCells}`} />
        <Card k="We are cheapest" v={`${weAreCheapest}`} accent />
        <Card k="Below Bosch min (MAP)" v={String(mapViolations)} />
      </section>

      <ComparisonTable products={products} competitors={competitors} />

      <div className="legend">
        <span><span className="dot" style={{ background: "var(--red)" }} />competitor cheaper than us (undercutting)</span>
        <span><span className="dot" style={{ background: "var(--green)" }} />competitor pricier than us (we win)</span>
        <span><span className="dot" style={{ background: "var(--amber)" }} />below Bosch threshold (MAP)</span>
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

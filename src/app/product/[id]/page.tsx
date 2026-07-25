import Link from "next/link";
import { getProductHistory } from "@/lib/queries";
import { query } from "@/lib/db";
import { HistoryChart } from "./HistoryChart";

export const dynamic = "force-dynamic";

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [product] = await query<{
    model_code: string;
    name: string | null;
    our_price: number | null;
    threshold_price: number | null;
  }>(
    `select model_code, name, our_price, threshold_price from tracked_products where id = $1`,
    [id],
  );

  const history = await getProductHistory(id);

  return (
    <main className="wrap">
      <p className="sub">
        <Link href="/">← All products</Link>
      </p>
      <header className="top">
        <h1>{product?.model_code ?? "Unknown"}</h1>
        <span className="muted">
          Our price: {product?.our_price ?? "—"} · Bosch min: {product?.threshold_price ?? "—"}
        </span>
      </header>

      {history.length === 0 ? (
        <p className="muted">No price history yet — the first snapshots appear after the next daily run.</p>
      ) : (
        <HistoryChart
          history={history}
          ourPrice={product?.our_price ?? null}
          threshold={product?.threshold_price ?? null}
        />
      )}
    </main>
  );
}

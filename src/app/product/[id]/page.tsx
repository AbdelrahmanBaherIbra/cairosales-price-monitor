import { getProductHistory } from "@/lib/queries";
import { query } from "@/lib/db";
import { HistoryChart } from "./HistoryChart";
import { BrandBar } from "@/components/BrandBar";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(n);
}

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
      <BrandBar
        title={product?.model_code ?? "Unknown"}
        tag={`Our price: ${fmt(product?.our_price)} · Bosch min: ${fmt(product?.threshold_price)}`}
        back
      />

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

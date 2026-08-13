"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { HistoryPoint } from "@/lib/queries";

const COLORS = [
  "#1f6feb", "#167a3a", "#d1202e", "#b7791f", "#8250df",
  "#0e8a94", "#bf3989", "#9a6700", "#2da44e", "#cf222e",
  "#0969da", "#bc4c00", "#6639ba",
];

export function HistoryChart({
  history,
  ourPrice,
  threshold,
}: {
  history: HistoryPoint[];
  ourPrice: number | null;
  threshold: number | null;
}) {
  // Pivot into { date, [competitorSlug]: price } rows.
  const slugs = [...new Set(history.map((h) => h.competitor_slug))];
  const names: Record<string, string> = {};
  history.forEach((h) => (names[h.competitor_slug] = h.competitor_name));

  const byDate = new Map<string, Record<string, number | string>>();
  for (const h of history) {
    const day = h.captured_at.slice(0, 10);
    const row = byDate.get(day) ?? { date: day };
    if (h.price != null) row[h.competitor_slug] = h.price;
    byDate.set(day, row);
  }
  const data = [...byDate.values()];

  return (
    <div style={{ width: "100%", height: 460, marginTop: 12 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e3e6ea" />
          <XAxis dataKey="date" stroke="#6b7480" />
          <YAxis stroke="#6b7480" tickFormatter={(v) => new Intl.NumberFormat("en-EG").format(v)} />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #e3e6ea", borderRadius: 8 }}
            formatter={(v: number, key: string) => [v, names[key] ?? key]}
          />
          <Legend formatter={(key) => names[key] ?? key} />
          {ourPrice != null && (
            <ReferenceLine y={ourPrice} stroke="#1b1f24" strokeDasharray="6 3" label="Us" />
          )}
          {threshold != null && (
            <ReferenceLine y={threshold} stroke="#b7791f" strokeDasharray="2 4" label="Bosch min" />
          )}
          {slugs.map((slug, i) => (
            <Line
              key={slug}
              type="monotone"
              dataKey={slug}
              stroke={COLORS[i % COLORS.length]}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

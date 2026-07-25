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
  "#4f9cff", "#2ea043", "#f85149", "#d29922", "#a371f7",
  "#39c5cf", "#db61a2", "#e3b341", "#7ee787", "#ff7b72",
  "#79c0ff", "#ffa657", "#d2a8ff",
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
          <CartesianGrid strokeDasharray="3 3" stroke="#263042" />
          <XAxis dataKey="date" stroke="#8b97a7" />
          <YAxis stroke="#8b97a7" tickFormatter={(v) => new Intl.NumberFormat("en-EG").format(v)} />
          <Tooltip
            contentStyle={{ background: "#141922", border: "1px solid #263042" }}
            formatter={(v: number, key: string) => [v, names[key] ?? key]}
          />
          <Legend formatter={(key) => names[key] ?? key} />
          {ourPrice != null && (
            <ReferenceLine y={ourPrice} stroke="#e6edf3" strokeDasharray="6 3" label="Us" />
          )}
          {threshold != null && (
            <ReferenceLine y={threshold} stroke="#d29922" strokeDasharray="2 4" label="Bosch min" />
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

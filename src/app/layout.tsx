import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cairo Sales — Competitor Price Monitor",
  description: "Daily competitor price comparison (Bosch pilot)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

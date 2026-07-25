import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dashboard reads live data server-side; never statically cache.
  experimental: {},
};

export default nextConfig;

import type { NextConfig } from "next";

const apiOrigin = process.env.RISK_API_ORIGIN ?? "http://127.0.0.1:8080";

const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: { root: __dirname },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;

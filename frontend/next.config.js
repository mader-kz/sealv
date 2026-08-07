/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },
  // The deployed shape: a static export served by the same FastAPI container
  // that owns /v1 - one origin, no CORS, works offline. `next dev` ignores
  // `output` and uses the rewrites below to reach a local backend instead.
  output: "export",
  images: { unoptimized: true },
  async rewrites() {
    // Dev only: the exporter drops rewrites from the built output.
    const api = process.env.DEV_API ?? "http://127.0.0.1:8090";
    return [
      { source: "/v1/:path*", destination: `${api}/v1/:path*` },
      { source: "/media/:path*", destination: `${api}/media/:path*` },
      { source: "/healthz", destination: `${api}/healthz` },
    ];
  },
};
module.exports = nextConfig;

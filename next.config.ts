import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  reactStrictMode: false,
  // The sandbox preview serves the app from dynamic *.space-z.ai subdomains;
  // without this, every cross-origin _next/* asset logs a dev warning.
  allowedDevOrigins: ["*.space-z.ai", "localhost"],
};

export default nextConfig;

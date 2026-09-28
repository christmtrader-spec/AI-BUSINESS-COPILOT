import type { NextConfig } from "next";

/**
 * Prompt 29 §97/§98 — safe baseline security headers.
 *
 * Chosen conservatively so browser behavior cannot regress:
 *  - nosniff + Referrer-Policy + frame protections are universally safe;
 *  - HSTS is added ONLY when PUBLIC_BASE_URL is an https origin — the header
 *    must never be claimed for an HTTP-only deployment (§97);
 *  - CSP: §98 forbids a blind aggressive CSP. The strengthened part adopted
 *    here is `frame-ancestors 'none'` (clickjacking protection with zero
 *    impact on Next.js asset loading). A full script/style CSP is documented
 *    as future hardening in docs/security/observability-and-logging.md.
 * Deployment-level headers (managed by Caddy) are documented in
 * docs/deployment/production-operations.md.
 */
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "").trim();
const httpsEnabled = publicBaseUrl.startsWith("https://");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'",
  },
  ...(httpsEnabled
    ? [{ key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  reactStrictMode: false,
  // The sandbox preview serves the app from dynamic *.space-z.ai subdomains;
  // without this, every cross-origin _next/* asset logs a dev warning.
  allowedDevOrigins: ["*.space-z.ai", "localhost"],
  async headers() {
    return [
      {
        // Baseline headers for every route (documents + APIs + SPA shell).
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

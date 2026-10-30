/**
 * scripts/r136-summary-range-probe.ts — R136 diagnostic.
 *
 * The browser QA of the R134 deep link showed the reports view rendering
 * "Unable to load the report. Retry" while the URL/hash and the window
 * label were CORRECT (2026-09-01 → 2026-09-30). This probe reproduces the
 * exact client query (GET /api/v1/reports/summary?from=&to=) as the QA
 * persona and reports status + body, alongside the ?days=30 baseline.
 *
 * Run: bun scripts/r136-summary-range-probe.ts
 */
export {};

const BASE = "http://localhost:3000";
const EMAIL = process.env.R134_QA_EMAIL ?? "r131-qa-mvutl29n@test.local";
const PW = process.env.R134_QA_PW ?? "R131-QA-2026!";
const BID = process.env.R134_QA_BID ?? "cmvutl4xm000bqa4l8rgj8zu1";

const jar = new Map<string, string>();
const f = async (path: string, init: RequestInit = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const raw = res.headers.get("set-cookie");
  if (raw) for (const piece of raw.split(/,(?=[^;]+=)/)) {
    const [pair] = piece.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
};

const csrf = (await (await f("/api/auth/csrf")).json()) as { csrfToken: string };
const login = await f("/api/auth/callback/credentials", {
  method: "POST",
  body: JSON.stringify({ csrfToken: csrf.csrfToken, email: EMAIL, password: PW, redirect: false }),
});
console.log("login:", login.status);

for (const q of ["?days=30", "?from=2026-09-01&to=2026-09-30", "?from=2026-08-01&to=2026-08-31"]) {
  const res = await f(`/api/v1/reports/summary${q}`, { headers: { "x-business-id": BID } });
  const text = await res.text();
  console.log(`${q} -> ${res.status} ${text.slice(0, 300)}`);
}

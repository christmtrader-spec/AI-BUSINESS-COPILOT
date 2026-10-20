#!/usr/bin/env bun
/**
 * R61-1 — weekly digest scheduler LIVE check.
 *
 * Proves the OPERATOR-SCHEDULED digest path end-to-end without faking
 * anything (auth via the REAL NextAuth credentials flow with a cookie jar,
 * same as e2e-smoke.ts):
 *  1. register a throwaway owner → NextAuth login (cookie jar)
 *  2. create business → customer → ONE real sale (issued today, in-window)
 *  3. run the real operator script (scripts/send-weekly-digest.mjs --send)
 *     as a SUBPROCESS against the same DB — dev console transport prints a
 *     clearly-marked structured send line (honest dev delivery, no vendor)
 *  4. assert the script output reports built>=1 sent>=1 and exit 0
 *  5. cleanup: delete throwaway business (confirmName)
 *
 * Run: bun scripts/r61-digest-send-check.ts
 */
const DIGEST_BASE = "http://localhost:3000";
const DIGEST_PASS = "DigestPass!2026x";
let pass = 0;
let fail = 0;

function digestCheck(name, ok, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function digestJarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.61.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${DIGEST_BASE}${path}`, { ...init, headers, redirect: "manual" });
    const raw = res.headers.get("set-cookie");
    if (raw) {
      for (const piece of raw.split(/,(?=[^;]+=)/)) {
        const [pair] = piece.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return res;
  };
}

async function digestLogin(email: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = digestJarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, email, password: DIGEST_PASS });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

async function digestApi(jar: Map<string, string>, path: string, businessId?: string, init: RequestInit = {}) {
  const f = digestJarFetch(jar);
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as object ?? {}) };
  if (businessId) headers["x-business-id"] = businessId;
  const res = await f(path, { ...init, headers });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON ok */ }
  return { status: res.status, body };
}

const stamp = Date.now();
const email = `r61digest${stamp}@t.dev`;

// 1. register + login
const reg = await fetch(`${DIGEST_BASE}/api/v1/auth/register`, {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.61.1.${stamp % 251}` },
  body: JSON.stringify({ name: "R61 Digest Owner", email, password: DIGEST_PASS }),
});
digestCheck("register 201", reg.status === 201, `status=${reg.status}`);
const jar = await digestLogin(email);
digestCheck("NextAuth login (cookie jar)", jar.has("next-auth.session-token") || jar.size > 0);

// 2. business + customer + sale in-window
const created = await digestApi(jar, "/api/v1/businesses", undefined, {
  method: "POST",
  body: JSON.stringify({ name: `R61 Digest Co ${stamp}`, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const biz = created.body?.data?.business;
digestCheck("business created", created.status === 200 || created.status === 201, `status=${created.status}`);
const BID = biz?.id ?? "";
if (!BID) { console.log("ABORT — no business id"); process.exit(1); }

const cust = await digestApi(jar, "/api/v1/customers", BID, { method: "POST", body: JSON.stringify({ name: "Digest Target Co", kind: "CUSTOMER" }) });
digestCheck("customer 201", cust.status === 201, `status=${cust.status}`);

const today = new Date().toISOString().slice(0, 11) + "12:00:00.000Z";
const sale = await digestApi(jar, "/api/v1/sales", BID, {
  method: "POST",
  body: JSON.stringify({
    customerId: cust.body?.data?.id,
    issueDate: today,
    items: [{ name: `Digest Widget ${stamp}`, unit: "pcs", qty: 2, unitPriceMinor: 2500 }],
  }),
});
digestCheck("sale 201 (in-window activity)", sale.status === 201, `status=${sale.status} body=${JSON.stringify(sale.body).slice(0, 140)}`);

// 3. run the REAL operator script with --send
const proc = spawnSync("bun", ["scripts/send-weekly-digest.mjs", "--send", `--business-id=${BID}`], {
  cwd: "/home/z/my-project",
  env: { ...process.env, NODE_ENV: "development" },
  stdout: "pipe", stderr: "pipe",
} as never);
const out = proc.stdout.toString() + proc.stderr.toString();
const finalLine = out.split("\n").filter((l) => l.includes('"job":"weekly-digest"')).pop() ?? "";
let summary: any = {};
try { summary = JSON.parse(finalLine); } catch { /* fallback regex below */ }
const built = summary.built ?? Number((out.match(/"built":(\d+)/) || [])[1] ?? -1);
const sent = summary.sent ?? Number((out.match(/"sent":(\d+)/) || [])[1] ?? -1);
const failed = summary.failed ?? Number((out.match(/"failed":(\d+)/) || [])[1] ?? -1);
digestCheck("digest built=1", built === 1, `built=${built}`);
digestCheck("digest sent=1 (dev console transport)", sent === 1, `sent=${sent}`);
digestCheck("digest failed=0", failed === 0, `failed=${failed}`);
const exitCode = (proc as unknown as { status: number | null }).status;
digestCheck("script exit 0", exitCode === 0, `exit=${exitCode}`);

// 4. cleanup
const del = await digestApi(jar, `/api/v1/businesses/${BID}`, BID, { method: "DELETE", body: JSON.stringify({ confirmName: `R61 Digest Co ${stamp}` }) });
digestCheck("cleanup: throwaway business deleted", del.status === 200 || del.status === 204, `status=${del.status}`);

console.log(`\n=== R61-1 digest-send-check: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
import { spawnSync } from "node:child_process";

export {};

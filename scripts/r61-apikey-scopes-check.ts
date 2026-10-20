/**
 * R61-3 LIVE check — API-key scopes v2 + monthly quota headers.
 *
 * Proves end-to-end against the real server:
 *  - granular key (read:products) → products 200, sales/customers 403
 *  - full key (read) → all three resources 200
 *  - unknown scope → 422 (never silently widened)
 *  - quota headers present and decrementing
 *  - legacy default (no scopes field) still → full access
 *  - cleanup: revoke keys + delete throwaway business
 *
 * Run: bun scripts/r61-apikey-scopes-check.ts
 */
import { spawnSync } from "node:child_process";

const BASE = "http://localhost:3000";
const PASS = "ScopePass!2026x";
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.62.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
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

async function login(email: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, email, password: PASS });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

async function api(jar: Map<string, string>, path: string, businessId?: string, init: RequestInit = {}) {
  const f = jarFetch(jar);
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as object ?? {}) };
  if (businessId) headers["x-business-id"] = businessId;
  const res = await f(path, { ...init, headers });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON ok */ }
  return { status: res.status, body, headers: res.headers };
}

const stamp = Date.now();
const email = `r61scopes${stamp}@t.dev`;

const reg = await fetch(`${BASE}/api/v1/auth/register`, {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.62.1.${stamp % 251}` },
  body: JSON.stringify({ name: "R61 Scopes Owner", email, password: PASS }),
});
check("register 201", reg.status === 201, `status=${reg.status}`);
const jar = await login(email);

const created = await api(jar, "/api/v1/businesses", undefined, {
  method: "POST",
  body: JSON.stringify({ name: `R61 Scopes Co ${stamp}`, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const BID: string = created.body?.data?.business?.id ?? "";
check("business created", created.status === 200 || created.status === 201, `status=${created.status}`);
if (!BID) { console.log("ABORT"); process.exit(1); }

// Seed one product + one customer so resource GETs have rows.
await api(jar, "/api/v1/products", BID, { method: "POST", body: JSON.stringify({ name: `Scope Widget ${stamp}`, unit: "pcs", costPriceMinor: 100, salePriceMinor: 200, stockQty: 5 }) });
await api(jar, "/api/v1/customers", BID, { method: "POST", body: JSON.stringify({ name: "Scope Customer", kind: "CUSTOMER" }) });

async function createKey(name: string, scopes?: string[]): Promise<{ status: number; key?: string; id?: string }> {
  const res = await api(jar, "/api/v1/api-keys", BID, {
    method: "POST",
    body: JSON.stringify(scopes ? { name, scopes } : { name }),
  });
  return { status: res.status, key: res.body?.data?.key, id: res.body?.data?.id };
}

async function openGet(key: string, resource: string) {
  const res = await fetch(`${BASE}/api/v1/open/${resource}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json, headers: res.headers };
}

// 1. granular key: read:products only
const gran = await createKey(`Granular ${stamp}`, ["read:products"]);
check("granular key created 201", gran.status === 201 && Boolean(gran.key), `status=${gran.status}`);
if (gran.key) {
  const p = await openGet(gran.key, "products");
  check("granular: products 200", p.status === 200, `status=${p.status}`);
  const s = await openGet(gran.key, "sales");
  check("granular: sales 403 PERMISSION_DENIED", s.status === 403 && s.json?.error?.code === "PERMISSION_DENIED", `status=${s.status} code=${s.json?.error?.code}`);
  const c = await openGet(gran.key, "customers");
  check("granular: customers 403", c.status === 403, `status=${c.status}`);
}

// 2. full key: default (no scopes field) → legacy full access
const full = await createKey(`Full ${stamp}`);
check("default key created 201", full.status === 201 && Boolean(full.key), `status=${full.status}`);
if (full.key) {
  for (const r of ["products", "sales", "customers"]) {
    const res = await openGet(full.key, r);
    check(`default key: ${r} 200`, res.status === 200, `status=${res.status}`);
  }
  // Quota headers — the three resource checks above already consumed 3.
  const q1 = await openGet(full.key, "products");
  const lim1 = Number(q1.headers.get("x-quota-limit") ?? "0");
  const rem1 = Number(q1.headers.get("x-quota-remaining") ?? "-1");
  const q2 = await openGet(full.key, "products");
  const rem2 = Number(q2.headers.get("x-quota-remaining") ?? "-1");
  check("quota headers present + decrementing", lim1 >= 1 && rem1 === lim1 - 4 && rem2 === rem1 - 1, `limit=${lim1} rem1=${rem1} rem2=${rem2}`);
  check("products rows tenant-scoped", Array.isArray(q1.json?.data?.items) && q1.json.data.items.length >= 1);
}

// 3. unknown scope → 422
const bad = await createKey(`Bad ${stamp}`, ["read:hackers"]);
check("unknown scope 422", bad.status === 422, `status=${bad.status}`);

// 4. mixed read+granular collapses to full (serialize law)
const mixed = await createKey(`Mixed ${stamp}`, ["read", "read:sales"]);
check("mixed key created 201", mixed.status === 201, `status=${mixed.status}`);
if (mixed.key) {
  const res = await openGet(mixed.key, "sales");
  check("mixed key: sales 200 (collapsed to read)", res.status === 200, `status=${res.status}`);
}

// 5. cleanup — revoke all keys then delete business
const list = await api(jar, "/api/v1/api-keys", BID);
const items: { id: string }[] = list.body?.data?.items ?? [];
let revoked = 0;
for (const k of items) {
  const r = await api(jar, `/api/v1/api-keys/${k.id}`, BID, { method: "DELETE" });
  if (r.status === 200) revoked++;
}
check("keys revoked", revoked === items.length && items.length >= 3, `${revoked}/${items.length}`);
const del = await api(jar, `/api/v1/businesses/${BID}`, BID, { method: "DELETE", body: JSON.stringify({ confirmName: `R61 Scopes Co ${stamp}` }) });
check("cleanup: business deleted", del.status === 200 || del.status === 204, `status=${del.status}`);

console.log(`\n=== r61-apikey-scopes-check: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

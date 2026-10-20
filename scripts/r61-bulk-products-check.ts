/**
 * R61-6 LIVE check — bulk product status endpoint.
 *
 * Proves: create N products → bulk deactivate (matched count honest) →
 * list reflects isActive=false → bulk activate back → forged/foreign id
 * is honestly reported (requested > matched) → validation caps + auth.
 *
 * Run: bun scripts/r61-bulk-products-check.ts
 */
const BULK_BASE = "http://localhost:3000";
const BULK_PASS = "BulkPass!2026x";
let pass = 0;
let fail = 0;

function bulkCheck(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function bulkJarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.63.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BULK_BASE}${path}`, { ...init, headers, redirect: "manual" });
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

async function bulkLogin(email: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = bulkJarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, email, password: BULK_PASS });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

async function bulkApi(jar: Map<string, string>, path: string, businessId?: string, init: RequestInit = {}) {
  const f = bulkJarFetch(jar);
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as object ?? {}) };
  if (businessId) headers["x-business-id"] = businessId;
  const res = await f(path, { ...init, headers });
  let body: any = null;
  try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
}

const stamp = Date.now();
const email = `r61bulk${stamp}@t.dev`;

const reg = await fetch(`${BULK_BASE}/api/v1/auth/register`, {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.63.1.${stamp % 251}` },
  body: JSON.stringify({ name: "R61 Bulk Owner", email, password: BULK_PASS }),
});
bulkCheck("register 201", reg.status === 201, `status=${reg.status}`);
const jar = await bulkLogin(email);

const created = await bulkApi(jar, "/api/v1/businesses", undefined, {
  method: "POST",
  body: JSON.stringify({ name: `R61 Bulk Co ${stamp}`, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const BID: string = created.body?.data?.business?.id ?? "";
bulkCheck("business created", created.status === 200 || created.status === 201, `status=${created.status}`);
if (!BID) { console.log("ABORT"); process.exit(1); }

// 3 products
const ids: string[] = [];
for (let i = 0; i < 3; i++) {
  const r = await bulkApi(jar, "/api/v1/products", BID, {
    method: "POST",
    body: JSON.stringify({ name: `Bulk Widget ${i} ${stamp}`, unit: "pcs", costPriceMinor: 100, salePriceMinor: 200 + i, stockQty: 5 }),
  });
  if (r.body?.data?.id) ids.push(r.body.data.id);
}
bulkCheck("3 products created", ids.length === 3, `ids=${ids.length}`);

// bulk deactivate
const de = await bulkApi(jar, "/api/v1/products/bulk-status", BID, {
  method: "POST",
  body: JSON.stringify({ ids, isActive: false }),
});
bulkCheck("bulk deactivate 200 matched=3", de.status === 200 && de.body?.data?.matched === 3, `status=${de.status} matched=${de.body?.data?.matched}`);

const list1 = await bulkApi(jar, "/api/v1/products", BID);
const allInactive = (list1.body?.data?.items ?? []).every((p: any) => p.isActive === false);
bulkCheck("list reflects all inactive", allInactive === true);

// forged + real id — requested 3, matched 1 (honest count)
const forged = [...ids.slice(0, 1), "nonexistent-id-1", "nonexistent-id-2"];
const partial = await bulkApi(jar, "/api/v1/products/bulk-status", BID, {
  method: "POST",
  body: JSON.stringify({ ids: forged, isActive: true }),
});
bulkCheck("forged ids: matched=1 requested=3", partial.status === 200 && partial.body?.data?.matched === 1 && partial.body?.data?.requested === 3, `matched=${partial.body?.data?.matched}`);

// bulk activate all back
const ac = await bulkApi(jar, "/api/v1/products/bulk-status", BID, {
  method: "POST",
  body: JSON.stringify({ ids, isActive: true }),
});
bulkCheck("bulk activate back matched=3", ac.status === 200 && ac.body?.data?.matched === 3);

// validation: empty ids 422 / over-cap 422
const empty = await bulkApi(jar, "/api/v1/products/bulk-status", BID, { method: "POST", body: JSON.stringify({ ids: [], isActive: true }) });
bulkCheck("empty ids 422", empty.status === 422, `status=${empty.status}`);
const overCap = await bulkApi(jar, "/api/v1/products/bulk-status", BID, { method: "POST", body: JSON.stringify({ ids: Array.from({ length: 201 }, (_, i) => `x${i}`), isActive: true }) });
bulkCheck("over-cap 201 ids 422", overCap.status === 422, `status=${overCap.status}`);

// unauthenticated 401
const unauth = await fetch(`${BULK_BASE}/api/v1/products/bulk-status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, isActive: true }) });
bulkCheck("unauthenticated 401", unauth.status === 401, `status=${unauth.status}`);

// cleanup
const del = await bulkApi(jar, `/api/v1/businesses/${BID}`, BID, { method: "DELETE", body: JSON.stringify({ confirmName: `R61 Bulk Co ${stamp}` }) });
bulkCheck("cleanup: business deleted", del.status === 200 || del.status === 204, `status=${del.status}`);

console.log(`\n=== r61-bulk-products-check: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

export {};

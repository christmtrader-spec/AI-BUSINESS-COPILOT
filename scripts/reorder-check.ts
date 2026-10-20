/**
 * Prompt 55 §X2 — live E2E for GET /api/v1/reports/reorder-suggestions.
 *
 * Real HTTP surface: register a throwaway owner → credentials login →
 * create a business → seed products across the whole severity matrix →
 * assert the SERVER-computed suggestions:
 *   - at-threshold and below-threshold included, above-threshold excluded
 *   - suggestedQty = max(threshold − stock, 1)  (equal case → 1)
 *   - estimatedCostMinor = suggestedQty × costPriceMinor (integer math)
 *   - OUT_OF_STOCK vs AT_OR_BELOW_THRESHOLD severity
 *   - inactive products never appear
 *   - totals: count + estimated total (null withheld if ANY row unsafe —
 *     unreachable through the API schema bounds, asserted as total present)
 *   - 401 without a session; private no-store header
 * Cleanup: the throwaway business is deleted via the documented danger
 * endpoint (typed confirm name) — suite-owned user remains (same policy
 * as e2e-smoke throwaway owners).
 *
 * Run: bun scripts/reorder-check.ts [--base http://localhost:3000]
 * Exit: 0 = all green, 1 = at least one failure.
 */
type Check = { name: string; ok: boolean; info?: string };
export {}; // module marker — the harness uses top-level await
const results: Check[] = [];
function record(name: string, ok: boolean, info?: string) {
  results.push({ name, ok, info });
  console.log(`${ok ? "✓" : "✗"} ${name}${info ? ` — ${info}` : ""}`);
}

const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > -1 ? process.argv[i + 1] : "http://localhost:3000";
})();
const PASS = "testpass123";
const RUN_XFF = `10.213.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": RUN_XFF,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
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
  if (res.status !== 302 && res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status}`);
  }
  return jar;
}

async function api(
  jar: Map<string, string>,
  path: string,
  businessId?: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: any }> {
  const f = jarFetch(jar);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (businessId) headers["x-business-id"] = businessId;
  const res = await f(path, { ...init, headers });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

const STAMP = Date.now();
const EMAIL = `reorder${STAMP}@t.dev`;
const BIZ_NAME = "Reorder Check Business";

// 1. Register + login + business
const reg = await fetch(`${BASE}/api/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": RUN_XFF },
  body: JSON.stringify({ name: "Reorder Throwaway Owner", email: EMAIL, password: PASS }),
});
record("register throwaway owner (201)", reg.status === 201, `status ${reg.status}`);
const owner = await login(EMAIL);

const bizRes = await api(owner, "/api/v1/businesses", undefined, {
  method: "POST",
  body: JSON.stringify({ name: BIZ_NAME, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const BIZ = bizRes.body?.data?.id ?? bizRes.body?.data?.business?.id;
record("create business (201 + id)", bizRes.status === 201 && typeof BIZ === "string", `status ${bizRes.status} id=${String(BIZ).slice(0, 8)}`);

async function createProduct(p: {
  name: string;
  sku?: string;
  unit?: string;
  stockQty: number;
  lowStockAt: number;
  costPriceMinor: number;
  isActive?: boolean;
}) {
  return api(owner, "/api/v1/products", BIZ, {
    method: "POST",
    body: JSON.stringify({ salePriceMinor: 10000, ...p }),
  });
}

// 2. Seed the severity matrix
const pOutOf = await createProduct({ name: "Zero stock item", sku: "ZS-1", unit: "pcs", stockQty: 0, lowStockAt: 5, costPriceMinor: 2500 });
const pLow = await createProduct({ name: "Low stock item", sku: "LS-1", unit: "box", stockQty: 3, lowStockAt: 5, costPriceMinor: 1000 });
const pEqual = await createProduct({ name: "At threshold item", sku: "EQ-1", stockQty: 5, lowStockAt: 5, costPriceMinor: 700 });
const pFine = await createProduct({ name: "Healthy stock item", sku: "OK-1", stockQty: 10, lowStockAt: 2, costPriceMinor: 500 });
const pInactive = await createProduct({ name: "Inactive low item", sku: "IN-1", stockQty: 1, lowStockAt: 4, costPriceMinor: 900 });
record("fixtures: 5 products created", [pOutOf, pLow, pEqual, pFine, pInactive].every((r) => r.status === 201), [pOutOf, pLow, pEqual, pFine, pInactive].map((r) => r.status).join(","));

const inactiveId = pInactive.body?.data?.id;
const deact = await api(owner, `/api/v1/products/${inactiveId}`, BIZ, {
  method: "PATCH",
  body: JSON.stringify({ isActive: false }),
});
record("fixture: product deactivated", deact.status === 200, `status ${deact.status}`);

// 3. 401 without a session
{
  const res = await fetch(`${BASE}/api/v1/reports/reorder-suggestions`, { headers: { "x-business-id": BIZ ?? "" } });
  record("unauthenticated request → 401", res.status === 401, `status ${res.status}`);
}

// 4. The report
const rep = await api(owner, "/api/v1/reports/reorder-suggestions", BIZ);
record("report 200 + ok envelope", rep.status === 200 && rep.body?.data?.basis === "low_stock_topup_suggestion", `status ${rep.status}`);
record("private no-store on report", (rep.headers.get("cache-control") ?? "").includes("no-store"), rep.headers.get("cache-control") ?? "");

const data = rep.body?.data;
const rows: Array<any> = data?.rows ?? [];
const bySku = new Map(rows.map((r: any) => [r.sku, r]));

record("exactly the 3 at/below-threshold ACTIVE products", rows.length === 3, `rows=${rows.length}`);
record(
  "out-of-stock row: suggested 5, est 12500, OUT_OF_STOCK",
  bySku.get("ZS-1")?.suggestedQty === 5 &&
    bySku.get("ZS-1")?.estimatedCostMinor === 12500 &&
    bySku.get("ZS-1")?.severity === "OUT_OF_STOCK",
  JSON.stringify(bySku.get("ZS-1")),
);
record(
  "low row: suggested 2, est 2000, AT_OR_BELOW_THRESHOLD",
  bySku.get("LS-1")?.suggestedQty === 2 &&
    bySku.get("LS-1")?.estimatedCostMinor === 2000 &&
    bySku.get("LS-1")?.severity === "AT_OR_BELOW_THRESHOLD",
  JSON.stringify(bySku.get("LS-1")),
);
record(
  "equal-threshold row: suggested qty floors at 1",
  bySku.get("EQ-1")?.stockQty === 5 && bySku.get("EQ-1")?.suggestedQty === 1,
  JSON.stringify(bySku.get("EQ-1")),
);
record("above-threshold product excluded", !bySku.has("OK-1"), "");
record("inactive product excluded", !bySku.has("IN-1"), "");
record(
  "totals: count 3, outOfStock 1, complete estimate",
  data?.totals?.suggestionCount === 3 &&
    data?.totals?.outOfStockCount === 1 &&
    data?.totals?.estimatedTotalMinor === 12500 + 2000 + 700,
  JSON.stringify(data?.totals),
);
record(
  "rows sorted by stock ascending (severest first)",
  rows[0]?.stockQty <= rows[1]?.stockQty && rows[1]?.stockQty <= rows[2]?.stockQty,
  rows.map((r: any) => r.stockQty).join(","),
);
record("integer minor units everywhere", rows.every((r: any) => Number.isSafeInteger(r.costPriceMinor) && (r.estimatedCostMinor == null || Number.isSafeInteger(r.estimatedCostMinor))), "");

// 5. No side effects: creating the report must not change stock
const prodList = await api(owner, "/api/v1/products?pageSize=100", BIZ);
const stockSum = (prodList.body?.data?.items ?? []).reduce((acc: number, p: any) => acc + p.stockQty, 0);
record("report had NO side effects on stock", stockSum === 0 + 3 + 5 + 10 + 1, `sum=${stockSum}`);

// 6. Cleanup — delete the throwaway business (typed confirm name)
const del = await api(owner, `/api/v1/businesses/${BIZ}`, BIZ, {
  method: "DELETE",
  body: JSON.stringify({ confirmName: BIZ_NAME }),
});
record("cleanup: throwaway business deleted", del.status === 200 && del.body?.data?.deleted === true, `status ${del.status}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}

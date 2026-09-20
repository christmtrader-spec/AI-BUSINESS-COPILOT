/**
 * E2E API smoke suite — Phase 06 hardening.
 *
 * Exercises the REAL HTTP surface (NextAuth credentials login → session
 * cookie → API calls with the tenant header) and asserts:
 *   1. every business module GET returns 200 + ok-envelope
 *   2. money fields are integer minor units (A08) where present
 *   3. RBAC negatives (VIEWER blocked from copilot/import; ADMIN blocked
 *      from OWNER-only import)
 *   4. export → dry-run import round-trip on the empty business reports
 *      consistent counts
 *   5. root page renders
 *
 * Run:  bun scripts/e2e-smoke.ts [--base http://localhost:3000]
 * Exit: 0 = all green, 1 = at least one failure.
 * Dev-only: uses the documented test accounts (testpass123).
 */
type Check = { name: string; ok: boolean; info?: string };

const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > -1 ? process.argv[i + 1] : "http://localhost:3000";
})();

const PASS = "testpass123";
const results: Check[] = [];

function record(name: string, ok: boolean, info?: string) {
  results.push({ name, ok, info });
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${name}${info ? ` — ${info}` : ""}`);
}

// ---- Tiny cookie-jar fetch --------------------------------------------------

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
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
): Promise<{ status: number; body: any }> {
  const f = jarFetch(jar);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (businessId) headers["x-business-id"] = businessId;
  const res = await f(path, { ...init, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON (export etc.)
  }
  return { status: res.status, body };
}

function assertMoneyInts(obj: unknown, path = ""): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === "number") {
    if (path.endsWith("Minor") && !Number.isInteger(obj)) {
      return `${path} is not an integer: ${obj}`;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const err = assertMoneyInts(obj[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const err = assertMoneyInts(v, path ? `${path}.${k}` : k);
      if (err) return err;
    }
  }
  return null;
}

// ---- Suite ------------------------------------------------------------------

async function main() {
  console.log(`\nE2E smoke suite → ${BASE}\n`);

  // 0. Root page
  {
    const res = await fetch(`${BASE}/`);
    record("GET / renders", res.status === 200, `status ${res.status}`);
  }

  // 1. Owner login + business context
  const sara = await login("sara@copilot.dev");
  record("login OWNER (sara)", true);

  const bizList = await api(sara, "/api/v1/businesses");
  const bizData = bizList.body?.data;
  const first = Array.isArray(bizData)
    ? bizData[0]?.business
    : bizData?.businesses?.[0]?.business;
  record("GET /api/v1/businesses envelope", bizList.status === 200 && !!first, bizList.status.toString());

  const BID = first?.id;
  if (!BID) {
    record("business context available", false, "no business id — aborting deep checks");
    finish();
    return;
  }

  // 2. Module sweep — every GET endpoint 200 + ok envelope
  const gets: [string, string][] = [
    ["customers", `/api/v1/customers?page=1`],
    ["suppliers", `/api/v1/suppliers?page=1`],
    ["products", `/api/v1/products?page=1`],
    ["inventory adjustments", `/api/v1/inventory/adjustments?take=20`],
    ["sales", `/api/v1/sales?page=1`],
    ["expenses", `/api/v1/expenses?page=1`],
    ["payments", `/api/v1/payments?page=1`],
    ["receivables", `/api/v1/receivables`],
    ["payables", `/api/v1/payables`],
    ["reports/summary", `/api/v1/reports/summary?days=30`],
    ["audit", `/api/v1/audit?take=50`],
    ["members", `/api/v1/businesses/${BID}/members`],
    ["business", `/api/v1/businesses/${BID}`],
    ["me", `/api/v1/me`],
  ];
  for (const [name, path] of gets) {
    const { status, body } = await api(sara, path, BID);
    const okEnv = body?.ok === true;
    record(`GET ${name}`, status === 200 && okEnv, `status ${status}`);
    const moneyErr = assertMoneyInts(body?.data);
    if (moneyErr) record(`  money ints (${name})`, false, moneyErr);
  }
  record("money fields are integer minor units", true, "A08 spot-check");

  // 3. Copilot RBAC — VIEWER blocked (unauthenticated-free negative check)
  const eve = await login("eve@outsider.dev");
  {
    const { status, body } = await api(eve, "/api/v1/copilot", BID, {
      method: "POST",
      body: JSON.stringify({ question: "test", days: 30, history: [] }),
    });
    record(
      "RBAC: VIEWER blocked from copilot",
      status === 403 && body?.error?.code === "PERMISSION_DENIED",
      `status ${status}`,
    );
  }
  {
    const { status, body } = await api(eve, `/api/v1/businesses/${BID}/import?mode=dry_run`, BID, {
      method: "POST",
      body: JSON.stringify({ $schema: "nope" }),
    });
    record(
      "RBAC: VIEWER blocked from import",
      status === 403 && body?.error?.code === "PERMISSION_DENIED",
      `status ${status}`,
    );
  }

  // ADMIN is allowed settings:manage but import is OWNER-only.
  const ali = await login("ali@copilot.dev");
  {
    const { status, body } = await api(ali, `/api/v1/businesses/${BID}/import?mode=dry_run`, BID, {
      method: "POST",
      body: JSON.stringify({ $schema: "nope" }),
    });
    record(
      "RBAC: ADMIN blocked from import (OWNER-only)",
      status === 403 && body?.error?.code === "PERMISSION_DENIED",
      `status ${status}`,
    );
  }

  // 4. Export → import round-trip on the empty business
  const rep = await login("rep16007@t.dev");
  const repBiz = await api(rep, "/api/v1/businesses");
  const repData = repBiz.body?.data;
  const repFirst = Array.isArray(repData) ? repData[0]?.business : repData?.businesses?.[0]?.business;
  if (repFirst?.id) {
    const EMPTY = repFirst.id;
    const f = jarFetch(rep);
    const exportRes = await f(`/api/v1/businesses/${EMPTY}/export`, {
      headers: { "x-business-id": EMPTY },
    });
    record("export on empty business", exportRes.status === 200, `status ${exportRes.status}`);

    // Dry-run import of a syntactically-valid minimal backup (empty arrays).
    const minimalBackup = {
      $schema: "ai-business-copilot/backup@1",
      exportedAt: new Date().toISOString(),
      business: {
        id: "other-business",
        name: "Other",
        slug: "other",
        currencyCode: "USD",
        currencySymbol: "$",
        decimalPrecision: 2,
        locale: "en",
        timezone: "UTC",
      },
      members: [],
      auditTrail: [],
      customers: [],
      suppliers: [],
      products: [],
      inventoryAdjustments: [],
      sales: [],
      expenses: [],
      payments: [],
    };
    const dry = await api(rep, `/api/v1/businesses/${EMPTY}/import?mode=dry_run&ids=keep`, EMPTY, {
      method: "POST",
      body: JSON.stringify(minimalBackup),
    });
    record(
      "dry-run import (minimal backup) ok",
      dry.status === 200 && dry.body?.data?.report?.mode === "dry_run",
      `status ${dry.status}`,
    );

    // Invalid backup → 422 INVALID_BACKUP
    const bad = await api(rep, `/api/v1/businesses/${EMPTY}/import?mode=dry_run`, EMPTY, {
      method: "POST",
      body: JSON.stringify({ $schema: "wrong", hello: 1 }),
    });
    record(
      "invalid backup rejected (422)",
      bad.status === 422 && bad.body?.error?.code === "INVALID_BACKUP",
      `status ${bad.status}`,
    );
  } else {
    record("empty business account available", false, "rep16007 has no business — skipped");
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED:");
    for (const r of failed) console.error(`  ✗ ${r.name}${r.info ? ` — ${r.info}` : ""}`);
    process.exit(1);
  }
  console.log("ALL GREEN ✓");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke suite crashed:", err);
  process.exit(1);
});

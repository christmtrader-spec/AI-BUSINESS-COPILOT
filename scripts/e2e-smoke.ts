/**
 * E2E API smoke suite — Phase 06 hardening.
 *
 * Exercises the REAL HTTP surface (NextAuth credentials login → session
 * cookie → API calls with the tenant header) and asserts:
 *   1. every business module GET returns 200 + ok-envelope
 *   2. money fields are integer minor units (A08) where present
 *   3. RBAC negatives (VIEWER blocked from copilot/import; ADMIN blocked
 *      from OWNER-only import AND OWNER-only business delete)
 *   4. export → dry-run import round-trip on the empty business reports
 *      consistent counts
 *   5. root page renders
 *   6. reports/monthly deterministic series + reports/export CSV
 *   7. copilot SSE stream contract (meta → deltas → done)
 *   8. danger zone: business delete cycle (create → RBAC → mismatch →
 *      delete → gone)
 *
 * Run:  bun scripts/e2e-smoke.ts [--base http://localhost:3000]
 * Exit: 0 = all green, 1 = at least one failure.
 * Dev-only: uses the documented test accounts (testpass123).
 */
type Check = { name: string; ok: boolean; info?: string };

import { PrismaClient } from "@prisma/client";

const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > -1 ? process.argv[i + 1] : "http://localhost:3000";
})();

const PASS = "testpass123";

// Per-run unique client IP — register/login limiters key on the caller IP,
// so a fixed IP can rate-limit the suite when other harnesses run in the
// same window (same isolation pattern as the prompt17-21 check scripts).
const RUN_XFF = `10.212.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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

  // 1a. Self-healing fixture sweep — a crashed/interrupted previous run can
  // leak its throwaway businesses ("Smoke *" names). A leaked throwaway trips
  // the FREE-plan BUSINESSES_MAX entitlement and permanently 422s the
  // throwaway creation steps of every later run (failure class found r22).
  // Sweep leaks BEFORE resolving the main business or creating new throwaways.
  {
    const preList = await api(sara, "/api/v1/businesses");
    const preItems: any[] = Array.isArray(preList.body?.data)
      ? preList.body.data
      : (preList.body?.data?.businesses ?? []);
    const leaked = preItems.filter((it) =>
      String(it?.business?.name ?? "").startsWith("Smoke "),
    );
    let swept = 0;
    for (const it of leaked) {
      const del = await api(sara, `/api/v1/businesses/${it.business.id}`, it.business.id, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: it.business.name }),
      });
      if (del.status === 200 || del.status === 201 || del.status === 204) swept++;
    }
    record(
      "self-heal: leaked throwaway businesses swept",
      swept === leaked.length,
      `${swept}/${leaked.length} deleted`,
    );
  }

  // 1b. Fresh throwaway owner — registered per run so the throwaway-based
  // sections always have full BUSINESSES_MAX headroom (the main account
  // sara sits at her FREE-plan limit of 1 business and must stay there)
  // and gets a fresh business:create rate bucket of its own.
  const ownerEmail = `smkowner${Date.now()}@t.dev`;
  const regOwner = await fetch(`${BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": RUN_XFF },
    body: JSON.stringify({
      name: "Smoke Throwaway Owner",
      email: ownerEmail,
      password: PASS,
    }),
  });
  record(
    "fixtures: fresh throwaway owner registered (201)",
    regOwner.status === 201,
    `status ${regOwner.status}`,
  );
  const smk = await login(ownerEmail);

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
    ["reports/monthly", `/api/v1/reports/monthly?months=6`],
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

  // 3. Copilot RBAC — VIEWER blocked on BOTH copilot transports
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
    // Stream transport must also be JSON-403 BEFORE any SSE bytes flow.
    const { status, body } = await api(eve, "/api/v1/copilot/stream", BID, {
      method: "POST",
      body: JSON.stringify({ question: "test", days: 30, history: [] }),
    });
    record(
      "RBAC: VIEWER blocked from copilot stream",
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

  // 5. WRITE-PATH PROBE — create → patch → delete a customer (full CRUD cycle).
  // Leaves only audit rows behind (customer rows are soft-deleted + the row
  // itself is removed from list scope by deletedAt filtering).
  {
    const createRes = await api(sara, "/api/v1/customers", BID, {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Probe Customer",
        note: "created by e2e-smoke write-path probe — safe to ignore",
      }),
    });
    const created = createRes.body?.data;
    record(
      "write: create customer",
      (createRes.status === 200 || createRes.status === 201) && !!created?.id,
      `status ${createRes.status}`,
    );

    if (created?.id) {
      const CID: string = created.id;
      const patchRes = await api(sara, `/api/v1/customers/${CID}`, BID, {
        method: "PATCH",
        body: JSON.stringify({ name: "Smoke Probe Customer (patched)" }),
      });
      record(
        "write: patch customer",
        patchRes.status === 200 && patchRes.body?.data?.name === "Smoke Probe Customer (patched)",
        `status ${patchRes.status}`,
      );

      const delRes = await api(sara, `/api/v1/customers/${CID}`, BID, { method: "DELETE" });
      record("write: delete customer", delRes.status === 200 || delRes.status === 204, `status ${delRes.status}`);

      const listRes = await api(sara, "/api/v1/customers?page=1&pageSize=200", BID);
      const rows = Array.isArray(listRes.body?.data)
        ? listRes.body.data
        : (listRes.body?.data?.items ?? listRes.body?.data?.customers ?? []);
      const stillThere = Array.isArray(rows) && rows.some((r: { id?: string }) => r?.id === CID);
      record("write: deleted customer gone from list", !stillThere, "soft-delete filtered");
    }
  }

  // 6. MONTH-OVER-MONTH + CSV EXPORT — deterministic aggregates + accountant
  // export. Monthly: series array, integer minors (A08). CSV: text/csv with
  // the standard section header and a money row.
  {
    const monthly = await api(sara, "/api/v1/reports/monthly?months=6", BID);
    const series = monthly.body?.data?.series;
    const moneyErr = assertMoneyInts(monthly.body?.data);
    record(
      "GET reports/monthly",
      monthly.status === 200 &&
        monthly.body?.ok === true &&
        Array.isArray(series) &&
        series.length === 6 &&
        typeof series[series.length - 1]?.month === "string" &&
        series[series.length - 1].month.length === 7,
      `status ${monthly.status}, months=${series?.length}`,
    );
    if (moneyErr) record("  money ints (monthly)", false, moneyErr);

    const f = jarFetch(sara);
    const csvRes = await f("/api/v1/reports/export?days=30", {
      headers: { "x-business-id": BID },
    });
    const csvText = csvRes.status === 200 ? await csvRes.text() : "";
    record(
      "GET reports/export (CSV)",
      csvRes.status === 200 &&
        (csvRes.headers.get("content-type") ?? "").includes("text/csv") &&
        csvText.includes("section,field,value") &&
        csvText.includes("kpi"),
      `status ${csvRes.status}`,
    );

    // RBAC: reports are data:read — VIEWER may read/export (mirrors UI).
    const eveCsv = await api(eve, "/api/v1/reports/monthly?months=6", BID);
    record(
      "RBAC: VIEWER may read reports/monthly (data:read)",
      eveCsv.status === 200,
      `status ${eveCsv.status}`,
    );
  }

  // 7. COPILOT STREAM SMOKE — real SSE round-trip: meta → deltas → done.
  // Asserts the grounding meta event (with counts) arrives first and at
  // least one answer delta follows. This consumes one real AI call.
  // DURABLE FIX (P28, mirrors P26 BUG #5): the probe runs against a FRESH
  // per-run business (the throwaway owner's), because sara's long-lived
  // shop accumulates FREE-plan AI quota across rounds and would 422
  // forever. The stream business is deleted right after, restoring the
  // throwaway owner's BUSINESSES_MAX headroom for section 8.
  let streamBizName: string | null = null;
  {
    try {
      const streamBiz = await api(smk, "/api/v1/businesses", undefined, {
        method: "POST",
        body: JSON.stringify({
          name: `Smoke Stream Biz ${Date.now()}`,
          currencyCode: "USD",
          locale: "en",
          timezone: "UTC",
        }),
      });
      const SB = streamBiz.body?.data?.business?.id as string | undefined;
      streamBizName = (streamBiz.body?.data?.business?.name as string) ?? null;
      record(
        "fixtures: fresh stream business created",
        (streamBiz.status === 200 || streamBiz.status === 201) && !!SB,
        `status ${streamBiz.status}`,
      );
      if (!SB) throw new Error("no stream business id");
      const f = jarFetch(smk);
      const res = await f("/api/v1/copilot/stream", {
        method: "POST",
        headers: { "content-type": "application/json", "x-business-id": SB },
        body: JSON.stringify({
          question: "How is my cash flow? (smoke probe)",
          days: 30,
          history: [],
        }),
      });
      const text = res.status === 200 ? await res.text() : "";
      const events = text
        .split("\n\n")
        .map((blk) => blk.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
        .filter(Boolean)
        .map((s) => {
          try {
            return JSON.parse(s as string);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<Record<string, unknown>>;

      const metaEvt = events.find((e) => e.meta);
      const metaObj = metaEvt?.meta as
        | { counts?: { sales?: number }; rangeFrom?: string; days?: number }
        | undefined;
      const deltaCount = events.filter((e) => typeof e.delta === "string" && e.delta).length;
      const sawDone = events.some((e) => e.done === true);
      record(
        "copilot stream: meta event with counts",
        res.status === 200 && !!metaObj && typeof metaObj.counts?.sales === "number",
        `status ${res.status}, sales=${metaObj?.counts?.sales}`,
      );
      record(
        "copilot stream: incremental deltas",
        deltaCount >= 1,
        `${deltaCount} delta events`,
      );
      record("copilot stream: terminal done event", sawDone);
      // Restore the throwaway owner's headroom (self-cleanup, §104-style).
      if (SB && streamBizName) {
        const del = await api(smk, `/api/v1/businesses/${SB}`, SB, {
          method: "DELETE",
          body: JSON.stringify({ confirmName: streamBizName }),
        });
        record(
          "fixtures: stream business deleted (headroom restored)",
          del.status === 200 || del.status === 204,
          `status ${del.status}`,
        );
      }
    } catch (err) {
      record("copilot stream smoke", false, String(err));
    }
  }

  // 8. DANGER ZONE — self-contained business delete cycle: create a
  // throwaway business, assert role enforcement + confirm-mismatch, delete
  // it for real, verify it is gone from the membership list.
  {
    const created = await api(smk, "/api/v1/businesses", undefined, {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Delete Business",
        currencyCode: "USD",
        locale: "en",
        timezone: "UTC",
      }),
    });
    const throwBiz = created.body?.data?.business;
    record(
      "danger: create throwaway business",
      (created.status === 200 || created.status === 201) && !!throwBiz?.id,
      `status ${created.status}, id=${throwBiz?.id}`,
    );

    if (throwBiz?.id) {
      const TB = throwBiz.id as string;

      // Role enforcement on a business where ali IS a member (ADMIN).
      const aliDel = await api(ali, `/api/v1/businesses/${BID}`, BID, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: "whatever" }),
      });
      record(
        "RBAC: ADMIN blocked from business delete (OWNER-only)",
        aliDel.status === 403 && aliDel.body?.error?.code === "PERMISSION_DENIED",
        `status ${aliDel.status}`,
      );

      // Danger counts endpoint — OWNER allowed on the throwaway.
      const counts = await api(smk, `/api/v1/businesses/${TB}/danger`, TB);
      record(
        "danger: counts endpoint (OWNER)",
        counts.status === 200 && typeof counts.body?.data?.customers === "number",
        `status ${counts.status}`,
      );

      // Wrong typed name → 422 CONFIRM_MISMATCH.
      const mismatch = await api(smk, `/api/v1/businesses/${TB}`, TB, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: "Wrong Name" }),
      });
      record(
        "danger: wrong confirm name rejected (422)",
        mismatch.status === 422 && mismatch.body?.error?.code === "CONFIRM_MISMATCH",
        `status ${mismatch.status}`,
      );

      // Correct typed name → business hard-deleted.
      const del = await api(smk, `/api/v1/businesses/${TB}`, TB, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: throwBiz.name ?? "Smoke Delete Business" }),
      });
      record(
        "danger: delete business (correct confirm)",
        del.status === 200 && del.body?.data?.deleted === true,
        `status ${del.status}`,
      );

      // Gone from the membership list.
      const listAfter = await api(smk, "/api/v1/businesses");
      const afterList = Array.isArray(listAfter.body?.data)
        ? listAfter.body.data
        : listAfter.body?.data?.businesses ?? [];
      const still = afterList.some((m: { business?: { id?: string } }) => m.business?.id === TB);
      record("danger: deleted business gone from list", !still, "membership refetched");
    }
  }

  // 9. INVITE LINKS — self-contained lifecycle on a throwaway business:
  // create business → mint invite → OWNER-role rejected → preview/accept
  // as a FRESHLY registered user → membership created → re-accept 410 →
  // delete the throwaway business (cascades invite + membership away).
  {
    const created = await api(smk, "/api/v1/businesses", undefined, {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Invite Business",
        currencyCode: "USD",
        locale: "en",
        timezone: "UTC",
      }),
    });
    const invBiz = created.body?.data?.business;
    record(
      "invites: create throwaway business",
      (created.status === 200 || created.status === 201) && !!invBiz?.id,
      `status ${created.status}`,
    );

    if (invBiz?.id) {
      const IB = invBiz.id as string;

      // OWNER role must never be mintable through an invite.
      const ownerInvite = await api(smk, `/api/v1/businesses/${IB}/invites`, IB, {
        method: "POST",
        body: JSON.stringify({ role: "OWNER", expiresInDays: 7 }),
      });
      record(
        "invites: OWNER role rejected (422 ROLE_NOT_INVITABLE)",
        ownerInvite.status === 422,
        `status ${ownerInvite.status}`,
      );

      // Mint a real invite (24h expiry).
      const mint = await api(smk, `/api/v1/businesses/${IB}/invites`, IB, {
        method: "POST",
        body: JSON.stringify({ role: "MANAGER", expiresInDays: 1 }),
      });
      const token = mint.body?.data?.token as string | undefined;
      record(
        "invites: mint link (201, 48-char token, expiry)",
        mint.status === 201 && typeof token === "string" && token.length >= 40,
        `status ${mint.status}, len ${token?.length}`,
      );

      // List must NOT leak the full token.
      const listInv = await api(smk, `/api/v1/businesses/${IB}/invites`, IB);
      const leaksToken =
        listInv.status === 200 && JSON.stringify(listInv.body?.data ?? {}).includes(token ?? "\\u0000");
      record(
        "invites: list never leaks full token",
        listInv.status === 200 && !leaksToken,
        `items ${Array.isArray(listInv.body?.data) ? listInv.body.data.length : "?"}`,
      );

      if (token) {
        // Unknown token → 404 (never a stack trace).
        const badToken = await api(smk, "/api/v1/invites/not-a-real-token");
        record(
          "invites: unknown token 404",
          badToken.status === 404 && badToken.body?.error?.code === "NOT_FOUND",
          `status ${badToken.status}`,
        );

        // Fresh user registers (no business), signs in, previews + accepts.
        const stamp = Date.now();
        const email = `inv${stamp}@t.dev`;
        const reg = await fetch(`${BASE}/api/v1/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": RUN_XFF },
          body: JSON.stringify({ name: "Smoke Invitee", email, password: PASS }),
        });
        record("invites: register invitee (201)", reg.status === 201, `status ${reg.status}`);

        const invitee = await login(email);

        const preview = await api(invitee, `/api/v1/invites/${token}`);
        record(
          "invites: preview (PENDING, not member)",
          preview.status === 200 &&
            preview.body?.data?.status === "PENDING" &&
            preview.body?.data?.callerIsMember === false &&
            preview.body?.data?.role === "MANAGER",
          `status ${preview.status}`,
        );

        const accept = await api(invitee, `/api/v1/invites/${token}`, undefined, {
          method: "POST",
        });
        record(
          "invites: accept (201, business + role)",
          accept.status === 201 &&
            accept.body?.data?.business?.id === IB &&
            accept.body?.data?.role === "MANAGER",
          `status ${accept.status}`,
        );

        // Re-accept → 410 INVITE_ACCEPTED (one-time token).
        const reAccept = await api(invitee, `/api/v1/invites/${token}`, undefined, {
          method: "POST",
        });
        record(
          "invites: re-accept blocked (410)",
          reAccept.status === 410 && reAccept.body?.error?.code === "INVITE_ACCEPTED",
          `status ${reAccept.status}`,
        );

        // Membership row really exists with the invited role.
        const members = await api(invitee, `/api/v1/businesses/${IB}/members`, IB);
        const rows = Array.isArray(members.body?.data) ? members.body.data : [];
        record(
          "invites: membership row created (MANAGER)",
          members.status === 200 && rows.some((m: { role?: string; user?: { email?: string } }) => m.role === "MANAGER" && m.user?.email === email),
          `members ${rows.length}`,
        );

        // VIEWER (eve) must NOT be able to mint invites.
        const eveMint = await api(eve, `/api/v1/businesses/${BID}/invites`, BID, {
          method: "POST",
          body: JSON.stringify({ role: "VIEWER", expiresInDays: 7 }),
        });
        record(
          "RBAC: VIEWER blocked from minting invites",
          eveMint.status === 403,
          `status ${eveMint.status}`,
        );
      }

      // Cleanup: delete the throwaway business (cascades invite + member).
      const delInvBiz = await api(smk, `/api/v1/businesses/${IB}`, IB, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: "Smoke Invite Business" }),
      });
      record(
        "invites: cleanup delete throwaway business",
        delInvBiz.status === 200,
        `status ${delInvBiz.status}`,
      );
    }
  }

  // 10. MONTH DETAIL — drill-down matches the monthly bucket discipline.
  {
    const monthly = await api(sara, "/api/v1/reports/monthly?months=6", BID);
    const series = monthly.body?.data?.series;
    const firstMonth = Array.isArray(series) ? series[0]?.month : null;
    if (typeof firstMonth === "string") {
      const detail = await api(sara, `/api/v1/reports/monthly/${firstMonth}`, BID);
      const d = detail.body?.data;
      const consistent =
        detail.status === 200 &&
        d?.month === firstMonth &&
        typeof d?.totals?.revenueMinor === "number" &&
        Number.isInteger(d.totals.revenueMinor) &&
        Array.isArray(d.sales) &&
        Array.isArray(d.expenses);
      record(
        "month detail: totals integer + lists present",
        consistent,
        `month ${firstMonth}`,
      );

      const bad = await api(sara, "/api/v1/reports/monthly/9999-99", BID);
      record(
        "month detail: invalid key rejected",
        bad.status === 404 || bad.status === 422,
        `status ${bad.status}`,
      );
    } else {
      record("month detail: monthly series available", false, "no months returned");
    }
  }

  // 11. COPILOT TRANSCRIPT PERSISTENCE (Phase 07) — lifecycle, caps, RBAC,
  //     per-user scoping, on a THROWAWAY business so the main account's real transcripts
  //     are never touched.
  {
    const created = await api(smk, "/api/v1/businesses", undefined, {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Chat Business",
        currencyCode: "USD",
        locale: "en",
        timezone: "UTC",
      }),
    });
    const chatBiz = created.body?.data?.business;
    record(
      "chat: create throwaway business",
      (created.status === 200 || created.status === 201) && !!chatBiz?.id,
      `status ${created.status}`,
    );

    if (chatBiz?.id) {
      const CB = chatBiz.id as string;
      const SID = "s-smoketest000000"; // valid client-format session id

      // First append AUTO-CREATES the session (with title).
      const m1 = await api(smk, `/api/v1/copilot/sessions/${SID}/messages`, CB, {
        method: "POST",
        body: JSON.stringify({
          role: "user",
          content: "How did sales do?",
          title: "How did sales do?",
        }),
      });
      record(
        "chat: append user message (201, creates session)",
        m1.status === 201 && typeof m1.body?.data?.message?.id === "string",
        `status ${m1.status}`,
      );

      const m2 = await api(smk, `/api/v1/copilot/sessions/${SID}/messages`, CB, {
        method: "POST",
        body: JSON.stringify({
          role: "assistant",
          content: "Revenue was computed from your records.",
          meta: { days: 30, sections: ["kpis"], counts: { sales: 1 } },
        }),
      });
      record(
        "chat: append assistant message with meta (201)",
        m2.status === 201,
        `status ${m2.status}`,
      );

      // List returns the session with both messages + title + parsed meta.
      const list = await api(smk, "/api/v1/copilot/sessions", CB);
      const sessions = Array.isArray(list.body?.data?.sessions)
        ? list.body.data.sessions
        : [];
      const found = sessions.find((s: { id?: string }) => s.id === SID);
      const metaOk =
        !!found?.messages?.[1]?.meta &&
        typeof found.messages[1].meta === "object" &&
        found.messages[1].meta.days === 30;
      record(
        "chat: list returns session (title, 2 messages, meta parsed)",
        list.status === 200 &&
          sessions.length === 1 &&
          found?.title === "How did sales do?" &&
          found?.messages?.length === 2 &&
          metaOk,
        `status ${list.status}, sessions ${sessions.length}`,
      );

      // r12 — PATCH rename: title changes, titleEdited flag set, auto-title
      // must never override it afterwards.
      const rename = await api(smk, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "PATCH",
        body: JSON.stringify({ title: "My renamed Q&A" }),
      });
      record(
        "chat: rename session (200, titleEdited)",
        rename.status === 200 &&
          rename.body?.data?.session?.title === "My renamed Q&A" &&
          rename.body?.data?.session?.titleEdited === true,
        `status ${rename.status}`,
      );

      // r12 — PATCH pin: pinned flag returned; list mirrors it.
      const pin = await api(smk, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "PATCH",
        body: JSON.stringify({ pinned: true }),
      });
      const listPinned = await api(smk, "/api/v1/copilot/sessions", CB);
      const pinnedFound = (listPinned.body?.data?.sessions ?? []).find(
        (s: { id?: string }) => s.id === SID,
      );
      record(
        "chat: pin session (200, list shows pinned)",
        pin.status === 200 &&
          pin.body?.data?.session?.pinned === true &&
          pinnedFound?.pinned === true,
        `status ${pin.status}, pinned ${String(pinnedFound?.pinned)}`,
      );

      // Append AFTER rename — the user-set title must survive (no auto-takeover).
      await api(smk, `/api/v1/copilot/sessions/${SID}/messages`, CB, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: "One more question" }),
      });
      const listAfterAppend = await api(smk, "/api/v1/copilot/sessions", CB);
      const afterFound = (listAfterAppend.body?.data?.sessions ?? []).find(
        (s: { id?: string }) => s.id === SID,
      );
      record(
        "chat: renamed title survives later appends",
        afterFound?.title === "My renamed Q&A" && afterFound?.messages?.length === 3,
        `title ${String(afterFound?.title)}, msgs ${String(afterFound?.messages?.length)}`,
      );

      // Validation negatives.
      const patchEmpty = await api(smk, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "PATCH",
        body: JSON.stringify({}),
      });
      record(
        "chat: PATCH with nothing to update rejected (422)",
        patchEmpty.status === 422,
        `status ${patchEmpty.status}`,
      );
      const patchEmptyTitle = await api(smk, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "PATCH",
        body: JSON.stringify({ title: "   " }),
      });
      record(
        "chat: PATCH blank title rejected (422)",
        patchEmptyTitle.status === 422,
        `status ${patchEmptyTitle.status}`,
      );
      const patchBad = await api(smk, `/api/v1/copilot/sessions/x`, CB, {
        method: "PATCH",
        body: JSON.stringify({ pinned: true }),
      });
      record(
        "chat: PATCH malformed session id rejected (422)",
        patchBad.status === 422,
        `status ${patchBad.status}`,
      );
      const aliPatch = await api(ali, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "PATCH",
        body: JSON.stringify({ pinned: true }),
      });
      record(
        "chat: non-member admin blocked from PATCH (403)",
        aliPatch.status === 403,
        `status ${aliPatch.status}`,
      );

      // Per-user scoping: ADMIN ali (same app, NOT a member of this
      // business) can never see or write Sara's transcripts.
      const aliList = await api(ali, "/api/v1/copilot/sessions", CB);
      record(
        "chat: non-member admin blocked from listing (403)",
        aliList.status === 403,
        `status ${aliList.status}`,
      );
      const aliAppend = await api(ali, `/api/v1/copilot/sessions/${SID}/messages`, CB, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: "intrusion?" }),
      });
      record(
        "chat: non-member admin blocked from appending (403)",
        aliAppend.status === 403,
        `status ${aliAppend.status}`,
      );

      // VIEWER excluded (RBAC matrix — copilot:use).
      const eveList = await api(eve, "/api/v1/copilot/sessions", BID);
      record(
        "RBAC: VIEWER blocked from chat transcripts (403)",
        eveList.status === 403,
        `status ${eveList.status}`,
      );

      // Malformed session id rejected before any DB touch.
      const badId = await api(smk, "/api/v1/copilot/sessions/bad-id!@/messages", CB, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: "x" }),
      });
      record(
        "chat: malformed session id rejected (422)",
        badId.status === 422,
        `status ${badId.status}`,
      );

      // Delete the session; second delete → 404 (gone).
      const del = await api(smk, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "DELETE",
      });
      record("chat: delete session (200)", del.status === 200, `status ${del.status}`);
      const reDel = await api(smk, `/api/v1/copilot/sessions/${SID}`, CB, {
        method: "DELETE",
      });
      record(
        "chat: re-delete session (404 NOT_FOUND)",
        reDel.status === 404 && reDel.body?.error?.code === "NOT_FOUND",
        `status ${reDel.status}`,
      );

      // Clear-all on empty store still succeeds (idempotent).
      const clear = await api(smk, "/api/v1/copilot/sessions", CB, { method: "DELETE" });
      record(
        "chat: clear-all (200, idempotent)",
        clear.status === 200 && typeof clear.body?.data?.deleted === "number",
        `status ${clear.status}`,
      );

      // Cleanup throwaway business (cascades any remaining chat rows).
      const delChatBiz = await api(smk, `/api/v1/businesses/${CB}`, CB, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: "Smoke Chat Business" }),
      });
      record(
        "chat: cleanup delete throwaway business",
        delChatBiz.status === 200,
        `status ${delChatBiz.status}`,
      );
    }
  }

  // 12. MONTH CSV EXPORT (Phase 07) — the drill-down dialog's export button
  //     speaks the same CSV contract as reports/export.
  {
    const monthly = await api(sara, "/api/v1/reports/monthly?months=6", BID);
    const series = monthly.body?.data?.series;
    const firstMonth = Array.isArray(series) ? series[0]?.month : null;
    if (typeof firstMonth === "string") {
      const res = await jarFetchRaw(sara, `/api/v1/reports/monthly/${firstMonth}/export?X=x`, BID);
      const csv = (await res.text()).replace(/^\uFEFF/, ""); // Response.text() strips the BOM
      const headerOk = csv.startsWith("section,field,value");
      const monthOk = csv.includes(`meta,month,${firstMonth}`);
      record(
        "month CSV export: 200 text/csv + meta month",
        res.status === 200 &&
          (res.headers.get("content-type") ?? "").includes("text/csv") &&
          headerOk &&
          monthOk,
        `status ${res.status}, bytes ${csv.length}`,
      );

      const bad = await jarFetchRaw(sara, "/api/v1/reports/monthly/9999-99/export", BID);
      record(
        "month CSV export: invalid month rejected (404)",
        bad.status === 404,
        `status ${bad.status}`,
      );
    } else {
      record("month CSV export: monthly series available", false, "no months returned");
    }
  }

  // 13. MONTH-FILTERED SALES/EXPENSES LISTS (r12) — "Open in Sales/Expenses"
  //     from the reports month dialog. The list ?month= filter must bucket
  //     rows with the SAME business-timezone month key as the drill-down.
  {
    const created = await api(smk, "/api/v1/businesses", undefined, {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Month Business",
        currencyCode: "USD",
        locale: "en",
        timezone: "UTC",
      }),
    });
    const mb = created.body?.data?.business;
    record(
      "month list: create throwaway business",
      (created.status === 200 || created.status === 201) && !!mb?.id,
      `status ${created.status}`,
    );

    if (mb?.id) {
      const MB = mb.id as string;
      // One sale + one expense inside 2026-03, one sale in 2026-04.
      const saleMar = await api(smk, "/api/v1/sales", MB, {
        method: "POST",
        body: JSON.stringify({
          items: [{ name: "Smoke item", unit: "pcs", qty: 2, unitPriceMinor: 1500 }],
          issueDate: "2026-03-15T12:00:00.000Z",
        }),
      });
      record(
        "month list: seed March sale (201)",
        saleMar.status === 201,
        `status ${saleMar.status}`,
      );
      await api(smk, "/api/v1/sales", MB, {
        method: "POST",
        body: JSON.stringify({
          items: [{ name: "Smoke item April", unit: "pcs", qty: 1, unitPriceMinor: 999 }],
          issueDate: "2026-04-02T09:00:00.000Z",
        }),
      });
      const expMar = await api(smk, "/api/v1/expenses", MB, {
        method: "POST",
        body: JSON.stringify({
          category: "Rent",
          amountMinor: 7000,
          spentAt: "2026-03-20T10:00:00.000Z",
        }),
      });
      record(
        "month list: seed March expense (201)",
        expMar.status === 201,
        `status ${expMar.status}`,
      );

      // March filter: exactly the one March sale.
      const salesMar = await api(smk, "/api/v1/sales?month=2026-03&page=1&pageSize=10", MB);
      const smItems = salesMar.body?.data?.items ?? [];
      record(
        "month list: sales ?month=2026-03 returns only March rows",
        salesMar.status === 200 &&
          salesMar.body?.data?.total === 1 &&
          smItems.length === 1 &&
          String(smItems[0]?.issueDate ?? "").startsWith("2026-03"),
        `status ${salesMar.status}, total ${String(salesMar.body?.data?.total)}`,
      );

      // Empty month: zero rows, still 200 (drives the localized empty state).
      const salesEmpty = await api(smk, "/api/v1/sales?month=2099-01&page=1&pageSize=10", MB);
      record(
        "month list: sales ?month=2099-01 → total 0",
        salesEmpty.status === 200 && salesEmpty.body?.data?.total === 0,
        `status ${salesEmpty.status}, total ${String(salesEmpty.body?.data?.total)}`,
      );

      // Malformed month: rejected.
      const salesBad = await api(smk, "/api/v1/sales?month=2026-13&page=1&pageSize=10", MB);
      record(
        "month list: invalid month rejected (422)",
        salesBad.status === 422,
        `status ${salesBad.status}`,
      );

      // Money fields stay integer minors in the filtered payload (A08).
      const moneyOk = assertMoneyInts(salesMar.body) === null;
      record("month list: filtered sales money integers (A08)", moneyOk);

      // Expenses mirror the same discipline.
      const expFiltered = await api(smk, "/api/v1/expenses?month=2026-03&page=1&pageSize=10", MB);
      record(
        "month list: expenses ?month=2026-03 returns only March rows",
        expFiltered.status === 200 &&
          expFiltered.body?.data?.total === 1 &&
          String(expFiltered.body?.data?.items?.[0]?.spentAt ?? "").startsWith("2026-03"),
        `status ${expFiltered.status}, total ${String(expFiltered.body?.data?.total)}`,
      );

      // Cleanup throwaway business (cascades sale/expense rows).
      const delMb = await api(smk, `/api/v1/businesses/${MB}`, MB, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: "Smoke Month Business" }),
      });
      record(
        "month list: cleanup delete throwaway business",
        delMb.status === 200,
        `status ${delMb.status}`,
      );
    }
  }

  // 13. FIXTURE CENSUS HYGIENE (R181 — the user-leak fix). The throwaway
  // sections ride the REAL register endpoints, so every run mints ONE owner
  // + ONE invitee USER row. The business delete cascades the invite + the
  // member, but the USER rows are global — each run leaked 2 (found LIVE:
  // the census 7/5 drifted to 11/5 after two runs today). The suite's final
  // act is erasing its OWN user fixtures — every row matching the smoke
  // email patterns, this run's AND any crashed run's leftovers (self-heal,
  // the §1a business sweep's spirit, at the DB layer: no user-delete API
  // exists and none SHOULD — account deletion is a product decision, not a
  // fixture one). Every User relation cascades (schema onDelete: Cascade).
  // Seed-contract safety: the only other @t.dev seed email is
  // rep16007@t.dev — it starts with neither prefix.
  {
    const prisma = new PrismaClient();
    try {
      const ownerSwept = await prisma.user.deleteMany({
        where: { email: { startsWith: "smkowner", endsWith: "@t.dev" } },
      });
      const invSwept = await prisma.user.deleteMany({
        where: { email: { startsWith: "inv", endsWith: "@t.dev" } },
      });
      record(
        "fixtures: smoke user rows swept (census hygiene, R181)",
        ownerSwept.count >= 1 && invSwept.count >= 1,
        `owners ${ownerSwept.count}, invitees ${invSwept.count}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  }

  finish();
}

/** Barebones authenticated fetch that returns the raw Response (non-JSON). */
async function jarFetchRaw(
  jar: Map<string, string>,
  path: string,
  businessId?: string,
): Promise<Response> {
  const f = jarFetch(jar);
  const headers: Record<string, string> = {};
  if (businessId) headers["x-business-id"] = businessId;
  return f(path, { headers });
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

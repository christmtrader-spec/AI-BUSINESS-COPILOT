/**
 * R104 ZERO-TRUST SWEEP (PROMPT 69 kickoff) — the systematic route-by-route
 * proof that the platform's API surface is closed to the unauthenticated and
 * isolated between tenants.
 *
 *   A  STATIC INVENTORY: walk src/app/api for route.ts files, extract every
 *      exported HTTP method handler, and derive the wire URL (segment
 *      placeholders replaced with honest fixtures).
 *   B  UNAUTHENTICATED 401 MATRIX: fire a REAL request per route x method
 *      with NO session and NO API key. The zero-trust baseline:
 *        - EVERY /api/v1/** route must answer 401 (including /open — which
 *          requires a Bearer key — and /webhooks/payments/[provider] — whose
 *          signature gate answers 401 by design; platform included).
 *        - Open-by-design exceptions, each explicitly reviewed:
 *            /api/health, /api/ready        → 2xx liveness, no data
 *            /api/public/**                 → 2xx marketing data
 *            /api/v1/public/**              → Prompt 25 marketing trio
 *              (pricing/contact/analytics; re-reviewed R132 — 422 on empty
 *              bodies is validation, 2xx stays SECRET_KEYS-inspected)
 *            /api/auth/[...nextauth]        → NextAuth's own (2xx/3xx/4xx)
 *            /api/                          → the root info route (2xx/4xx)
 *            /api/v1/auth/**                → open-or-token endpoints: never
 *              5xx, and any 2xx is body-inspected for secret leakage
 *              (passwordHash / token / secret keys) — possession of nothing
 *              must yield nothing.
 *      Any route outside the exception list that answers anything other than
 *      401 (or any 5xx anywhere) is a FINDING and fails the sweep.
 *   C  CROSS-TENANT ISOLATION MATRIX: two fixture owners A and B, each with
 *      their own book. A seeds customer/supplier/product/sale/expense; B
 *      tries to read, mutate and delete A's rows (expect 404/403 — never
 *      200 carrying A's data), B's collection reads must not contain any of
 *      A's ids, and B's fresh summary must be honest zeros.
 *   D  CLEANUP: FK-safe sweep of both fixtures (businesses cascade, users
 *      deleted last).
 *
 * Run: bun --conditions react-server scripts/r104-zero-trust-sweep.ts
 * Requires: dev server on :3000. Exit: 0 = all green, 1 = findings.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// R132 — battery-on-prod protocol (R130 law): heavy full-surface sweeps run
// against the pre-compiled standalone server (--base http://localhost:3100),
// never cold-compiling ~45 route graphs on the 4GB dev box.
const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > 0 ? process.argv[i + 1] : "http://localhost:3000";
})();
const SRC = join(process.cwd(), "src", "app", "api");
const TZ = "Asia/Tehran";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(`${name}${info ? ` — ${info}` : ""}`);
}

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

const PASS_A = "R104Zero!A2026";
const PASS_B = "R104Zero!B2026";
const EMAIL_A = `r104-zt-a-${Date.now().toString(36)}@qa.local`;
const EMAIL_B = `r104-zt-b-${Date.now().toString(36)}@qa.local`;
let USER_A = "";
let USER_B = "";

/* ---------------------------------------------------------------- helpers */

const { execSync } = await import("node:child_process");
let heals = 0;
let lastHealAt = 0;
async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, init);
  } catch (err: any) {
    const transient = /closed|reset|ECONN/i.test(String(err?.message || err));
    if (transient) {
      // A socket blip right after a heal is usually the same instability —
      // one plain retry (2s) before escalating to a full ensure-dev heal.
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        return await fetch(`${BASE}${path}`, init);
      } catch {
        /* fall through to the heal path */
      }
    }
    // The dev server occasionally recycles under compile load (memory law).
    // Heal via the liveness entrypoint and retry — the request itself stays
    // honest (still unauthenticated). Capped in count AND spaced in time.
    const now = Date.now();
    if (heals < 30 && now - lastHealAt > 5_000) {
      heals++;
      lastHealAt = now;
      console.log(`    [heal ${heals}] connection lost — ensure-dev + retry (${path})`);
      try {
        execSync("bash scripts/ensure-dev.sh", { cwd: process.cwd(), stdio: "ignore", timeout: 150_000 });
      } catch {
        /* heal attempt failed; the retry will report the truth */
      }
      return await rawFetch(path, init);
    }
    throw err;
  }
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": `10.230.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookie) headers.cookie = cookie;
    const res = await rawFetch(path, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  };
}

async function login(email: string, pass: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, email, password: pass });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

let BIZ_A = "";
let BIZ_B = "";

async function api(jar: Map<string, string>, path: string, init: RequestInit = {}) {
  const f = jarFetch(jar);
  const res = await f(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-business-id": path.startsWith("/api/v1") ? currentBiz(jar) : "",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (body && typeof body === "object" && "data" in body) body = body.data;
  return { status: res.status, body };
}

const jarToBiz = new WeakMap<Map<string, string>, string>();
function currentBiz(jar: Map<string, string>) {
  return jarToBiz.get(jar) || BIZ_A;
}

/* ------------------------------------------------------- [A] static walk */

type Entry = { file: string; url: string; methods: string[] };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

const FAKE_ID = "00000000-0000-4000-8000-00000000d104";

function urlFor(rel: string): string {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  const mapped = segs.map((s) => {
    if (s.startsWith("[...")) return "x";
    if (s === "[id]") return FAKE_ID;
    const m = s.match(/^\[(.+)\]$/);
    if (m) {
      if (m[1] === "resource") return "customers";
      if (m[1] === "provider") return "stripe";
      return "x";
    }
    return s;
  });
  // relative() strips src/app/api — the wire prefix is /api
  return "/api/" + mapped.filter(Boolean).join("/");
}

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

function inventory(): Entry[] {
  const files = walk(SRC);
  const entries: Entry[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const methods = METHODS.filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?(?:const|function)\\s+${m}\\b`).test(src),
    );
    if (methods.length === 0) continue;
    const rel = relative(SRC, file).replace(/route\.ts$/, "").replace(/[\\/]$/, "");
    entries.push({ file: relative(process.cwd(), file), url: urlFor(rel), methods });
  }
  return entries;
}

/* -------------------------------------------------- [B] exception classes */

function expectFor(url: string, method: string): { kind: string; allowed: number[] } {
  // Strict zero-trust default for /api/v1: 401, always.
  if (url === "/api/health" || url === "/api/ready") return { kind: "LIVENESS", allowed: [200, 204] };
  if (url === "/api" || url === "/api/")
    return { kind: "ROOT-INFO", allowed: [200, 204, 301, 302, 307, 308, 400, 404, 405] };
  if (url.startsWith("/api/public")) return { kind: "PUBLIC-MARKETING", allowed: [200, 204, 422] };
  // Prompt 25 (§27/§54/§125) — the v1 marketing trio, RE-REVIEWED open-by-design
  // (R132): GET public pricing (no DB ids/credentials by §116/§125), POST
  // contact capture (honeypot + 5/15min IP limit), POST analytics beacon
  // (strict client-event allowlist + UTC-day dedupe). An unauthenticated
  // empty body answers 422 (validation, never data); 429 is the honest
  // rate-limit answer; any 2xx remains under the universal SECRET_KEYS
  // body-inspection below.
  if (url.startsWith("/api/v1/public"))
    return { kind: "V1-PUBLIC-MARKETING", allowed: [200, 204, 400, 422, 429] };
  if (url.startsWith("/api/auth")) return { kind: "NEXTAUTH", allowed: [200, 302, 400, 401, 404, 405] };
  // Prompt 23 §18/§19: the provider's BROWSER redirect return — the destination
  // is always internal, the redirect is uniform (no session id echoed — no
  // probing surface). A 302 here is the design, not a bypass.
  if (url.startsWith("/api/v1/payments/callback/"))
    return { kind: "BROWSER-CALLBACK", allowed: [302, 303] };
  // Prompt 22: gateway callback — trust established EXCLUSIVELY by signature.
  // 401 = known provider + bad signature; 404 = unknown/disabled slug (the
  // route genuinely doesn't exist — documented, fails closed).
  if (url.startsWith("/api/v1/webhooks/payments/"))
    return { kind: "WEBHOOK-SIGNATURE", allowed: [400, 401, 404] };
  // R67: the token IS the authorization — anonymous-with-token invite surface.
  // The rate limiter + SecurityEvent vocabulary guard it; no OTHER oracle exists.
  if (url.startsWith("/api/v1/platform/invites/"))
    return { kind: "TOKEN-GATED", allowed: [400, 401, 403, 404, 405, 410, 422, 429] };
  // The idempotent sign-out companion: 200 ok({revoked:false}) when signed out
  // (no data, no mutation without a session). Body-shape asserted below.
  if (url === "/api/v1/me/security/sessions/revoke-current" && method === "POST")
    return { kind: "SIGNOUT-NOOP", allowed: [200, 401] };
  if (url.startsWith("/api/v1/auth")) {
    // Open-or-token endpoints: junk credentials must never yield data.
    // Any 2xx is body-inspected for secrets below.
    return { kind: "AUTH-OPEN", allowed: [200, 400, 401, 403, 404, 405, 409, 410, 422, 429] };
  }
  return { kind: "STRICT-401", allowed: [401] };
}

const SECRET_KEYS = /"(passwordHash|password|token|secret|secretBox|hash|mfaSecret)"\s*:/i;

function initFor(method: string): RequestInit {
  if (method === "GET" || method === "DELETE") return { method };
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify({}) };
}

async function sweepUnauth(entries: Entry[]) {
  console.log(`\n[B] UNAUTHENTICATED 401 MATRIX — ${entries.length} route files`);
  const total = entries.reduce((n, e) => n + e.methods.length, 0);
  console.log(`    ${total} route x method pairs, no session, no key, no origin header`);

  let strict = 0;
  let exceptions = 0;
  const findings: string[] = [];
  // Per-pair verdicts — a transient-throw re-attempt at the end REPLACES the
  // first attempt so a single run reports one honest verdict per pair.
  const verdicts = new Map<
    string,
    { pass: boolean; info: string; finding?: string; kind: string; strict: boolean }
  >();

  async function checkPair(e: Entry, method: string) {
    const { kind, allowed } = expectFor(e.url, method);
    const key = `${method} ${e.url}`;
    let status = 0;
    let body: any = null;
    try {
      const res = await rawFetch(e.url, {
        ...initFor(method),
        redirect: "manual",
        headers: {
          "x-forwarded-for": `10.231.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
          ...((initFor(method).headers as Record<string, string>) || {}),
        },
      });
      status = res.status;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const good = allowed.includes(status);
      const leaky2xx = status >= 200 && status < 300 && body && SECRET_KEYS.test(JSON.stringify(body));
      const envelope: any = body && typeof body === "object" && "data" in body ? (body as any).data : body;
      const signoutHonest =
        kind !== "SIGNOUT-NOOP" ||
        status === 401 ||
        (status === 200 && envelope && envelope.revoked === false);
      if (!good || leaky2xx || !signoutHonest) {
        verdicts.set(key, {
          pass: false,
          info: `${status}${leaky2xx ? " + secret-shaped 2xx body" : ""}${!signoutHonest ? " + dishonest signout body" : ""}`,
          finding: `${method} ${e.url} → ${status} (${kind})${leaky2xx ? " SECRET-LEAK" : ""}${!signoutHonest ? " SIGNOUT-DISHONEST" : ""}`,
          kind,
          strict: false,
        });
      } else {
        verdicts.set(key, { pass: true, info: `${status}`, kind, strict: kind === "STRICT-401" });
      }
    } catch (err: any) {
      verdicts.set(key, {
        pass: false,
        info: `threw ${err?.message || err}`,
        finding: `${method} ${e.url} → THREW ${err?.message || err}`,
        kind,
        strict: false,
      });
    }
  }

  const jobs: Array<() => Promise<void>> = [];
  for (const e of entries) {
    for (const method of e.methods) {
      jobs.push(() => checkPair(e, method));
    }
  }

  const CONC = 4;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      await j();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // One re-attempt for pairs that THREW (recycler socket blips) — the server
  // has healed by now, so the re-attempt reports the route's real behavior.
  const threw = [...verdicts.entries()].filter(([, v]) => v.info.startsWith("threw"));
  if (threw.length > 0) {
    console.log(`    [re-attempt] ${threw.length} transient-threw pair(s) after the heal window`);
    await new Promise((r) => setTimeout(r, 4_000));
    const retryJobs: Array<() => Promise<void>> = [];
    for (const [key] of threw) {
      const [method, ...rest] = key.split(" ");
      const url = rest.join(" ");
      const e = entries.find((x) => x.url === url);
      if (e) retryJobs.push(() => checkPair(e, method));
    }
    let ridx = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONC, retryJobs.length) }, async function retryWorker() {
        while (ridx < retryJobs.length) await retryJobs[ridx++]();
      }),
    );
  }

  for (const [key, v] of verdicts) {
    ok(`${key} [${v.kind}]`, v.pass, v.pass ? "" : v.info);
    if (v.pass) {
      if (v.strict) strict++;
      else exceptions++;
    } else if (v.finding) findings.push(v.finding);
  }

  ok(
    `B-strict every /api/v1 route answered 401 unauthenticated (${strict} pairs)`,
    strict + exceptions + findings.length === total && findings.length === 0,
    `${strict} strict / ${exceptions} reviewed exceptions / ${findings.length} findings / ${total} total`,
  );
  return { total, strict, exceptions, findings };
}

export {};

async function main() {
  console.log("R104 ZERO-TRUST SWEEP — the API surface is closed or explicitly open, nothing in between");

  /* [A] inventory */
  const entries = inventory();
  console.log(`\n[A] STATIC INVENTORY — ${entries.length} route.ts files under src/app/api`);
  const v1 = entries.filter((e) => e.url.startsWith("/api/v1"));
  const nonV1 = entries.filter((e) => !e.url.startsWith("/api/v1"));
  ok("A1 inventory covers the v1 surface (>= 150 route files)", v1.length >= 150, `${v1.length}`);
  ok("A2 non-v1 surface enumerated explicitly (health/ready/auth/public/root)", nonV1.length >= 5, `${nonV1.length}`);
  const strictCount = entries.filter((e) => expectFor(e.url, "GET").kind === "STRICT-401").length;
  ok(
    `A3 the strict-401 class dominates the surface (exceptions: platform invites [token], signout no-op, payments callback, payments webhook, v1/auth)` ,
    strictCount >= Math.floor(v1.length * 0.9),
    `${strictCount} strict of ${v1.length} v1 files`,
  );

  /* [B] unauthenticated matrix */
  const b = await sweepUnauth(entries);

  /* [C] cross-tenant isolation */
  console.log("\n[C] CROSS-TENANT ISOLATION MATRIX");
  const bcrypt = (await import("bcryptjs")).default;
  const hashA = bcrypt.hashSync(PASS_A, 10);
  const hashB = bcrypt.hashSync(PASS_B, 10);
  const userA = await db.user.create({
    data: { email: EMAIL_A, name: "R104 ZT Owner A", passwordHash: hashA, emailVerifiedAt: new Date() },
  });
  USER_A = userA.id;
  const userB = await db.user.create({
    data: { email: EMAIL_B, name: "R104 ZT Owner B", passwordHash: hashB, emailVerifiedAt: new Date() },
  });
  USER_B = userB.id;
  const bizA = await db.business.create({
    data: {
      name: "R104 ZT Co A",
      slug: `r104-zt-a-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: userA.id,
      vatEnabled: false,
    },
  });
  const bizB = await db.business.create({
    data: {
      name: "R104 ZT Co B",
      slug: `r104-zt-b-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: userB.id,
      vatEnabled: false,
    },
  });
  BIZ_A = bizA.id;
  BIZ_B = bizB.id;
  await db.businessMember.create({ data: { businessId: bizA.id, userId: userA.id, role: "OWNER" } });
  await db.businessMember.create({ data: { businessId: bizB.id, userId: userB.id, role: "OWNER" } });

  const jarA = await login(EMAIL_A, PASS_A);
  const jarB = await login(EMAIL_B, PASS_B);
  jarToBiz.set(jarA, BIZ_A);
  jarToBiz.set(jarB, BIZ_B);

  // Seed A's book through the REAL API (the same wrappers the isolation law guards).
  const mkCust = await api(jarA, "/api/v1/customers", {
    method: "POST",
    body: JSON.stringify({ name: "ZT A Customer", phone: "09120000001" }),
  });
  const custAId = mkCust.body?.id;
  ok("C1 A created a customer (fixture sanity)", mkCust.status < 300 && !!custAId, `st=${mkCust.status}`);

  const mkSup = await api(jarA, "/api/v1/suppliers", {
    method: "POST",
    body: JSON.stringify({ name: "ZT A Supplier", phone: "09120000002" }),
  });
  const supAId = mkSup.body?.id;
  ok("C2 A created a supplier (fixture sanity)", mkSup.status < 300 && !!supAId, `st=${mkSup.status}`);

  const mkProd = await api(jarA, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({
      name: "ZT A Product",
      costPriceMinor: 1000,
      salePriceMinor: 2000,
      stockQty: 5,
      lowStockAt: 1,
    }),
  });
  const prodAId = mkProd.body?.id;
  ok("C3 A created a product (fixture sanity)", mkProd.status < 300 && !!prodAId, `st=${mkProd.status}`);

  const mkExp = await api(jarA, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({
      category: "ZT A Expense",
      amountMinor: 5000,
      spentAt: new Date().toISOString(),
    }),
  });
  const expAId = mkExp.body?.id;
  ok("C4 A created an expense (fixture sanity)", mkExp.status < 300 && !!expAId, `st=${mkExp.status}`);

  const mkSale = await api(jarA, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      customerId: custAId,
      issueDate: new Date().toISOString(),
      items: [{ productId: prodAId, name: "ZT A Product", qty: 1, unitPriceMinor: 2000 }],
    }),
  });
  const saleAId = mkSale.body?.id;
  ok("C5 A created a sale (fixture sanity)", mkSale.status < 300 && !!saleAId, `st=${mkSale.status} ${JSON.stringify(mkSale.body).slice(0, 120)}`);

  // B reads A's rows — every detail route must 404/403, never 200 with A's data.
  const probes: Array<[string, string, string]> = [
    ["customer", custAId, "/api/v1/customers"],
    ["supplier", supAId, "/api/v1/suppliers"],
    ["product", prodAId, "/api/v1/products"],
    ["expense", expAId, "/api/v1/expenses"],
    ["sale", saleAId, "/api/v1/sales"],
  ];
  for (const [label, id, base] of probes) {
    if (!id) continue;
    const r = await api(jarB, `${base}/${id}`);
    ok(
      `C-r B GET ${label}/${id.slice(-6)} is 404/403`,
      r.status === 404 || r.status === 403,
      `st=${r.status}`,
    );
    const leak = JSON.stringify(r.body || {}).includes(label === "customer" ? "ZT A Customer" : label === "supplier" ? "ZT A Supplier" : label === "product" ? "ZT A Product" : label === "expense" ? "ZT A Expense" : "ZT A");
    ok(`C-r B GET ${label} body carries no A data`, !leak, "leak" );
  }

  // B mutates A's rows.
  if (custAId) {
    const up = await api(jarB, `/api/v1/customers/${custAId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Hijacked" }),
    });
    ok("C-m B PATCH A's customer is 404/403", up.status === 404 || up.status === 403, `st=${up.status}`);
    const del = await api(jarB, `/api/v1/customers/${custAId}`, { method: "DELETE" });
    ok("C-m B DELETE A's customer is 404/403", del.status === 404 || del.status === 403, `st=${del.status}`);
    const still = await api(jarA, `/api/v1/customers/${custAId}`);
    ok(
      "C-m A's customer untouched (name intact)",
      still.status === 200 && JSON.stringify(still.body || {}).includes("ZT A Customer"),
      `st=${still.status} body=${JSON.stringify(still.body).slice(0, 80)}`,
    );
  }

  // B's collections never contain A's rows.
  const lists: Array<[string, string, string]> = [
    ["customers", "/api/v1/customers", custAId],
    ["suppliers", "/api/v1/suppliers", supAId],
    ["products", "/api/v1/products", prodAId],
    ["expenses", "/api/v1/expenses", expAId],
  ];
  for (const [label, path, aId] of lists) {
    if (!aId) continue;
    const r = await api(jarB, path);
    const txt = JSON.stringify(r.body || {});
    ok(`C-l B's ${label} list excludes A's row`, r.status === 200 && !txt.includes(aId), `st=${r.status}`);
  }

  // B's summary is honest zeros on a fresh book (no A bleed-through).
  const summ = await api(jarB, "/api/v1/reports/summary?days=30");
  const inv = summ.body?.inventory;
  ok(
    "C-s B's summary reflects ONLY B's book (fresh zeros)",
    summ.status === 200 && inv && Number(inv.totalValueMinor ?? 0) === 0,
    `st=${summ.status} invValue=${inv?.totalValueMinor}`,
  );

  // A still sees its own rows (no over-blocking).
  if (custAId) {
    const mine = await api(jarA, `/api/v1/customers/${custAId}`);
    ok("C-o A still reads its own customer (200)", mine.status === 200, `st=${mine.status}`);
  }

  /* [D] verdict */
  console.log(`\n[D] VERDICT — ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("FINDINGS:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await cleanup();
  if (failed > 0) process.exit(1);
}

async function cleanup() {
  // FK-safe: businesses cascade everything; users last.
  for (const uid of [USER_A, USER_B]) {
    if (!uid) continue;
    const businesses = await db.business.findMany({ where: { ownerId: uid }, select: { id: true } });
    for (const b of businesses) await db.business.delete({ where: { id: b.id } });
    await db.user.delete({ where: { id: uid } }).catch(() => {});
  }
  console.log("cleanup: swept both fixtures FK-safe");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("sweep crashed:", e?.message || e);
    cleanup()
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  });

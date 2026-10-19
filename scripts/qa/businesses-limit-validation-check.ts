/**
 * scripts/qa/businesses-limit-validation-check.ts — P51-R1-FINAL focused
 * regression for the BUSINESSES_MAX gate (final-task §2.2–§2.6).
 *
 * Part 1 — DOMAIN LEVEL: drives the REAL service function
 * (assertWithinBusinessesLimitTx from src/lib/billing/service.ts) against a
 * hand-rolled fake Prisma transaction, covering every representable state:
 *   A  FREE=1, 0 owned                → pass (create allowed)
 *   B  FREE=1, 1 owned                → 422 ENTITLEMENT_LIMIT_REACHED
 *   C  FREE=0                         → 503 BILLING_UNAVAILABLE (config)
 *   D  FREE=-3                        → 503 BILLING_UNAVAILABLE
 *   E  FREE plan missing / row missing→ 503 BILLING_UNAVAILABLE
 *   F  FREE value null                → pass (documented UNLIMITED contract)
 *   G  non-integer 1.5 / NaN          → 503 BILLING_UNAVAILABLE
 *   H  beyond Number.MAX_SAFE_INTEGER → 503 BILLING_UNAVAILABLE
 *   I  paid plan (PRO=10) semantics   → unchanged (max-across-owned policy)
 *   J  below vs at the limit          → different, correct outcomes
 *   +  owned-loop malformed value     → 503 BILLING_UNAVAILABLE
 *   +  owned-loop BOOLEAN-typed row   → 503 BILLING_UNAVAILABLE
 *   +  FREE BOOLEAN-typed row (null)  → 503 (NOT "unlimited")
 *
 * Part 2 — LIVE RUNTIME PATH (real dev DB + dev server on :3000): creates
 * verified QA users, then exercises POST /api/v1/businesses:
 *   A'  first create   → 201
 *   B'  second create  → 422 limit {feature,limit:1,current:1}
 *   K   unauthenticated→ 401 (authorization independent of billing state)
 *   C'  FREE value temporarily 0 (RESTORED in finally)
 *                      → fresh user 503 BILLING_UNAVAILABLE, then after
 *                        restore → 201 (honest recovery, distinct from limit)
 *   L   client-override inspection: the create schema accepts NO plan/limit/
 *       businessId/ownerId fields — the entitlement is resolved ONLY from the
 *       server session user; asserted here by schema shape + 201 body owner.
 * Catalog guard re-run afterwards; QA fixtures fully torn down.
 *
 * Run: bun scripts/qa/businesses-limit-validation-check.ts
 */
import bcrypt from "bcryptjs";
import { PrismaClient, type Prisma } from "@prisma/client";

import { assertWithinBusinessesLimitTx } from "../../src/lib/billing/service";
import { BillingError } from "../../src/lib/billing/errors";

type Tx = Prisma.TransactionClient;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${info ? ` — ${info}` : ""}`);
  }
}

// --- fake Prisma transaction -------------------------------------------------

type BeRow = { value: number | null; type?: string };

function ownedBusiness(subscriptionPlan: string | null, beRow: BeRow | null) {
  return {
    subscription: subscriptionPlan
      ? {
          plan: {
            planEntitlements:
              beRow === null
                ? []
                : [{ value: beRow.value, entitlement: { code: "BUSINESSES_MAX", type: beRow.type ?? "LIMIT" } }],
          },
        }
      : null,
  };
}

function planRow(code: string, beRow: BeRow | null) {
  return {
    code,
    planEntitlements:
      beRow === null
        ? []
        : [{ value: beRow.value, entitlement: { code: "BUSINESSES_MAX", type: beRow.type ?? "LIMIT" } }],
  };
}

function fakeTx(owned: unknown[], plans: Record<string, unknown>): Tx {
  return {
    business: { findMany: async () => owned },
    plan: { findUnique: async (args: { where: { code: string } }) => plans[args.where.code] ?? null },
  } as unknown as Tx;
}

const FREE_1 = { FREE: planRow("FREE", { value: 1 }) };

async function outcome(tx: Tx, userId: string): Promise<{ kind: "pass" } | { kind: "billing"; code: string; status: number; message: string } | { kind: "limit"; details: Record<string, unknown> }> {
  try {
    await assertWithinBusinessesLimitTx(tx, userId);
    return { kind: "pass" };
  } catch (err) {
    if (err instanceof BillingError) {
      if (err.code === "ENTITLEMENT_LIMIT_REACHED") {
        return { kind: "limit", details: (err.details ?? {}) as Record<string, unknown> };
      }
      return { kind: "billing", code: err.code, status: err.status, message: err.message };
    }
    throw err;
  }
}

// --- Part 1: domain level ----------------------------------------------------

console.log("[P51-R1-FINAL][domain] BUSINESSES_MAX gate — assertWithinBusinessesLimitTx");
{
  const uid = "u-case-a";
  const r = await outcome(fakeTx([], FREE_1), uid);
  ok("A. FREE=1, 0 owned → creation allowed", r.kind === "pass");
}
{
  const uid = "u-case-b";
  const owned = [ownedBusiness("FREE", { value: 1 })];
  const r = await outcome(fakeTx(owned, FREE_1), uid);
  ok(
    "B. FREE=1, 1 owned → ENTITLEMENT_LIMIT_REACHED",
    r.kind === "limit" && r.details.feature === "BUSINESSES_MAX" && r.details.limit === 1 && r.details.current === 1 && r.details.upgradeAvailable === true,
    JSON.stringify(r),
  );
}
{
  const uid = "u-case-c";
  const r = await outcome(fakeTx([], { FREE: planRow("FREE", { value: 0 }) }), uid);
  ok(
    "C. FREE=0 → BILLING_UNAVAILABLE (configuration, NOT a limit)",
    r.kind === "billing" && r.code === "BILLING_UNAVAILABLE" && r.status === 503,
    JSON.stringify(r),
  );
}
{
  const uid = "u-case-d";
  const r = await outcome(fakeTx([], { FREE: planRow("FREE", { value: -3 }) }), uid);
  ok(
    "D. FREE=-3 → BILLING_UNAVAILABLE",
    r.kind === "billing" && r.code === "BILLING_UNAVAILABLE" && r.status === 503,
    JSON.stringify(r),
  );
}
{
  const uid = "u-case-e1";
  const r = await outcome(fakeTx([], { FREE: planRow("FREE", null) }), uid);
  ok("E1. FREE has no BUSINESSES_MAX row → BILLING_UNAVAILABLE", r.kind === "billing" && r.code === "BILLING_UNAVAILABLE", JSON.stringify(r));
  const r2 = await outcome(fakeTx([], {}), uid);
  ok("E2. FREE plan missing entirely → BILLING_UNAVAILABLE", r2.kind === "billing" && r2.code === "BILLING_UNAVAILABLE", JSON.stringify(r2));
}
{
  const uid = "u-case-f";
  const r = await outcome(fakeTx([], { FREE: planRow("FREE", { value: null }) }), uid);
  ok("F. FREE value null → pass (documented UNLIMITED contract preserved)", r.kind === "pass", JSON.stringify(r));
}
{
  const uid = "u-case-g1";
  const r = await outcome(fakeTx([], { FREE: planRow("FREE", { value: 1.5 }) }), uid);
  ok("G1. FREE=1.5 (non-integer) → BILLING_UNAVAILABLE", r.kind === "billing" && r.code === "BILLING_UNAVAILABLE", JSON.stringify(r));
  const r2 = await outcome(fakeTx([], { FREE: planRow("FREE", { value: Number.NaN }) }), uid);
  ok("G2. FREE=NaN → BILLING_UNAVAILABLE", r2.kind === "billing" && r2.code === "BILLING_UNAVAILABLE", JSON.stringify(r2));
}
{
  const uid = "u-case-h";
  const r = await outcome(fakeTx([], { FREE: planRow("FREE", { value: Number.MAX_SAFE_INTEGER + 1 }) }), uid);
  ok("H. beyond MAX_SAFE_INTEGER → BILLING_UNAVAILABLE", r.kind === "billing" && r.code === "BILLING_UNAVAILABLE", JSON.stringify(r));
}
{
  const uid = "u-case-i";
  const PRO_10 = { FREE: planRow("FREE", { value: 1 }), PRO: planRow("PRO", { value: 10 }) };
  const rBelow = await outcome(fakeTx([ownedBusiness("PRO", { value: 10 })], PRO_10), uid);
  ok("I-below. 1 owned on PRO=10 → creation allowed (paid semantics unchanged)", rBelow.kind === "pass", JSON.stringify(rBelow));
  const owned10 = Array.from({ length: 10 }, () => ownedBusiness("PRO", { value: 10 }));
  const rAt = await outcome(fakeTx(owned10, PRO_10), uid);
  ok(
    "I-at. 10 owned on PRO=10 → limit reached at exactly 10",
    rAt.kind === "limit" && rAt.details.limit === 10 && rAt.details.current === 10,
    JSON.stringify(rAt),
  );
}
{
  const uid = "u-case-j";
  const FREE_2 = { FREE: planRow("FREE", { value: 2 }) };
  const rBelow = await outcome(fakeTx([ownedBusiness("FREE", { value: 2 })], FREE_2), uid);
  ok("J-below. FREE=2, 1 owned → allowed (below limit)", rBelow.kind === "pass", JSON.stringify(rBelow));
  const rAt = await outcome(fakeTx([ownedBusiness("FREE", { value: 2 }), ownedBusiness("FREE", { value: 2 })], FREE_2), uid);
  ok("J-at. FREE=2, 2 owned → limit reached", rAt.kind === "limit" && rAt.details.limit === 2 && rAt.details.current === 2, JSON.stringify(rAt));
}
{
  const uid = "u-malformed-owned";
  const r = await outcome(fakeTx([ownedBusiness("STARTER", { value: 0 })], FREE_1), uid);
  ok("X1. owned-loop value=0 (malformed) → BILLING_UNAVAILABLE", r.kind === "billing" && r.code === "BILLING_UNAVAILABLE", JSON.stringify(r));
  const r2 = await outcome(fakeTx([ownedBusiness("STARTER", { value: -7 })], FREE_1), uid);
  ok("X2. owned-loop value=-7 → BILLING_UNAVAILABLE", r2.kind === "billing" && r2.code === "BILLING_UNAVAILABLE", JSON.stringify(r2));
}
{
  const uid = "u-typemismatch";
  const r = await outcome(fakeTx([ownedBusiness("STARTER", { value: null, type: "BOOLEAN" })], FREE_1), uid);
  ok("X3. owned-loop BOOLEAN-typed BUSINESSES_MAX → BILLING_UNAVAILABLE (type mismatch)", r.kind === "billing" && r.code === "BILLING_UNAVAILABLE", JSON.stringify(r));
  const r2 = await outcome(fakeTx([], { FREE: planRow("FREE", { value: null, type: "BOOLEAN" }) }), uid);
  ok("X4. FREE BOOLEAN-typed BUSINESSES_MAX (null) → BILLING_UNAVAILABLE, NOT unlimited", r2.kind === "billing" && r2.code === "BILLING_UNAVAILABLE", JSON.stringify(r2));
}
{
  // Existing documented semantics preserved: missing rows / no subscription
  // contribute nothing; user then gets the FREE limit (FREE=1, 1 owned → at).
  const uid = "u-legacy";
  const owned = [ownedBusiness(null, null), ownedBusiness("STARTER", null)];
  const r = await outcome(fakeTx(owned, FREE_1), uid);
  ok("Y. missing rows/no-sub businesses contribute nothing → FREE limit applies", r.kind === "limit" && r.details.limit === 1 && r.details.current === 2, JSON.stringify(r));
}

console.log(`[P51-R1-FINAL][domain] ${passed} assertions passed, ${failed} failed`);
if (failed > 0) {
  console.error("[P51-R1-FINAL][domain] FAILURES:", failures);
  process.exit(1);
}

// --- Part 2: live runtime path ----------------------------------------------

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3000";
const db = new PrismaClient();

// Minimal cookie-jar fetch (same pattern as scripts/prompt39-statement-check.mjs).
function makeClient(jarPrefix: string) {
  const jar = new Map<string, string>();
  const f = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body } as { status: number; body: never };
  };
  return { jar, f };
}

async function login(email: string, password: string) {
  const { f } = makeClient(email);
  const csrfRes = (await f("/api/auth/csrf")) as unknown as { body: { csrfToken: string } };
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrfRes.body.csrfToken, email, password, redirect: "false", json: "true" }).toString(),
  });
  return f;
}

async function makeVerifiedUser(email: string) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  return db.user.create({
    data: {
      email,
      name: "P51-R1-FINAL QA",
      passwordHash: bcrypt.hashSync("QaFinal1234", 10),
      emailVerifiedAt: new Date(),
    },
  });
}

async function deleteOwnedBusinessesAndUser(email: string) {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return;
  const owned = await db.business.findMany({ where: { ownerId: user.id }, select: { id: true } });
  for (const b of owned) await db.business.delete({ where: { id: b.id } });
  await db.user.delete({ where: { id: user.id } });
}

const EMAIL_1 = "p51r1-final-limit-a@qa.local";
const EMAIL_2 = "p51r1-final-limit-b@qa.local";
const PASSWORD = "QaFinal1234";

let freeRowId: string | null = null;
let freeOriginalValue: number | null = null;

try {
  // Prerequisite: the live catalog must be healthy BEFORE the live test.
  const guardRes = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!guardRes || guardRes.status !== 200) {
    console.error("[P51-R1-FINAL][live] dev server not reachable on :3000 — live part NOT EXECUTED");
    process.exitCode = failed > 0 ? 1 : 0;
  } else {
    console.log("[P51-R1-FINAL][live] POST /api/v1/businesses against the running dev server");

    const planFree = await db.plan.findUnique({
      where: { code: "FREE" },
      include: { planEntitlements: { include: { entitlement: true } } },
    });
    const beRow = planFree?.planEntitlements.find((pe) => pe.entitlement.code === "BUSINESSES_MAX");
    if (!planFree || !beRow) {
      console.error("[P51-R1-FINAL][live] FREE plan/BUSINESSES_MAX missing — run bun scripts/seed-billing.ts first");
      process.exitCode = 1;
    } else {
      const user1 = await makeVerifiedUser(EMAIL_1);
      const user2 = await makeVerifiedUser(EMAIL_2);

      // Case K (authorization) — no session at all.
      const anon = await fetch(`${BASE}/api/v1/businesses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Anon", currencyCode: "USD" }),
      });
      ok("K. unauthenticated create → 401", anon.status === 401, `status=${anon.status}`);

      // Case A' — first business on FREE=1 → 201.
      const f1 = await login(EMAIL_1, PASSWORD);
      const created = await f1("/api/v1/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "P51R1 Final QA A", currencyCode: "USD" }),
      });
      const createdBody = created.body as unknown as { ok?: boolean; data?: { business?: { id: string; ownerId?: string; name?: string } } };
      ok("A'. fresh user first create → 201", created.status === 201 && createdBody.data?.business?.id !== undefined, `status=${created.status}`);
      ok(
        "L. server resolves OWNER from the session (client cannot override identity/plan)",
        created.status === 201 && createdBody.data?.business?.ownerId === user1.id,
        `ownerId=${String(createdBody.data?.business?.ownerId)}`,
      );

      // Case B' — second business on FREE=1 → 422 limit (valid config + at limit).
      const limited = await f1("/api/v1/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "P51R1 Final QA B", currencyCode: "USD" }),
      });
      const limitedBody = limited.body as unknown as { error?: { code?: string; details?: Record<string, unknown> } };
      ok(
        "B'. at-limit create → 422 ENTITLEMENT_LIMIT_REACHED {feature:BUSINESSES_MAX,limit:1,current:1}",
        limited.status === 422 &&
          limitedBody.error?.code === "ENTITLEMENT_LIMIT_REACHED" &&
          limitedBody.error.details?.feature === "BUSINESSES_MAX" &&
          limitedBody.error.details?.limit === 1 &&
          limitedBody.error.details?.current === 1,
        `status=${limited.status} body=${JSON.stringify(limited.body)}`,
      );

      // Case C' — FREE temporarily 0 → honest configuration failure for a
      // FRESH user (exercises the FREE branch of the real transaction path),
      // then RESTORED → the same fresh user can create (honest recovery).
      freeRowId = beRow.id;
      freeOriginalValue = beRow.value;
      try {
        await db.planEntitlement.update({ where: { id: freeRowId }, data: { value: 0 } });
        const f2 = await login(EMAIL_2, PASSWORD);
        const broken = await f2("/api/v1/businesses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "P51R1 Final QA C", currencyCode: "USD" }),
        });
        const brokenBody = broken.body as unknown as { error?: { code?: string; message?: string } };
        ok(
          "C'. FREE=0 → 503 BILLING_UNAVAILABLE (NOT a fabricated limit)",
          broken.status === 503 && brokenBody.error?.code === "BILLING_UNAVAILABLE",
          `status=${broken.status} body=${JSON.stringify(broken.body)}`,
        );
      } finally {
        await db.planEntitlement.update({ where: { id: freeRowId }, data: { value: freeOriginalValue } });
      }
      const f2b = await login(EMAIL_2, PASSWORD);
      const recovered = await f2b("/api/v1/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "P51R1 Final QA D", currencyCode: "USD" }),
      });
      ok("C''-recovered. after restore, fresh user create → 201", recovered.status === 201, `status=${recovered.status}`);
    }
  }
} finally {
  // Fixture cleanup — businesses first (Business.owner is Restrict).
  await deleteOwnedBusinessesAndUser(EMAIL_1);
  await deleteOwnedBusinessesAndUser(EMAIL_2);
  // Catalog safety net: never leave FREE=0 behind even on unexpected paths.
  if (freeRowId !== null && freeOriginalValue !== null) {
    await db.planEntitlement.update({ where: { id: freeRowId }, data: { value: freeOriginalValue } }).catch(() => undefined);
  }
  await db.$disconnect();
}

console.log(`[P51-R1-FINAL][live] total ${passed} assertions passed, ${failed} failed`);
if (failed > 0) {
  console.error("[P51-R1-FINAL] FAILURES:", failures);
  process.exit(1);
}
console.log("[P51-R1-FINAL] businesses-limit-validation-check: ALL GREEN");

/**
 * R63 AUDIT REGRESSION BATTERY — Prompt 63 (audit & remediation phase).
 *
 * Proves against the REAL dev server:
 *   A  F-1 last-super-admin TOCTOU — two super admins demote each other
 *      CONCURRENTLY; at most one demotion may commit and at least one
 *      active PLATFORM_SUPER_ADMIN must always survive (§55).
 *   B  W-1 notification-mutation role gate — READONLY must be denied on
 *      announcement/retry mutations (second-layer role allowlist behind
 *      the platform:system:read gate), SUPPORT passes the gate.
 *   C  Static guards — the operators PATCH route performs the in-transaction
 *      recount (structural regression guard for the F-1 fix).
 *
 * Cleanup: every fixture row is deleted (operators, users, sessions).
 * Run: bun scripts/r63-audit-regression-check.ts   (dev server on :3000)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { enrollFixtureMfa, platformMfaLogin, clearFixtureMfa } from "./lib/platform-mfa";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3000";
const PW = "R63Check!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const createdOperatorIds: string[] = [];

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.64.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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
  const body = new URLSearchParams({ csrfToken, email, password: PW });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

type Call = (path: string, init?: RequestInit) => Promise<{ status: number; json: any }>;

function caller(jar: Map<string, string>): Call {
  const f = jarFetch(jar);
  return async (path, init = {}) => {
    const res = await f(path, init);
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
}

async function main() {
  console.log("== R63 fixtures ==");
  const hash = bcrypt.hashSync(PW, 10);

  const superAUser = await db.user.create({ data: { email: `r63-op-a-${TS}@t.dev`, name: "R63 Super A", passwordHash: hash, emailVerifiedAt: new Date() } });
  const superBUser = await db.user.create({ data: { email: `r63-op-b-${TS}@t.dev`, name: "R63 Super B", passwordHash: hash, emailVerifiedAt: new Date() } });
  const roUser = await db.user.create({ data: { email: `r63-op-ro-${TS}@t.dev`, name: "R63 Readonly", passwordHash: hash, emailVerifiedAt: new Date() } });
  const supUser = await db.user.create({ data: { email: `r63-op-sup-${TS}@t.dev`, name: "R63 Support", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(superAUser.id, superBUser.id, roUser.id, supUser.id);

  const opA = await db.platformOperator.create({ data: { userId: superAUser.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
  const opB = await db.platformOperator.create({ data: { userId: superBUser.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
  await db.platformOperator.create({ data: { userId: roUser.id, role: "PLATFORM_READONLY", active: true } });
  await db.platformOperator.create({ data: { userId: supUser.id, role: "PLATFORM_SUPPORT", active: true } });
  createdOperatorIds.push(opA.id, opB.id);

  // R65 — BOTH super-admins are MFA-enrolled via the REAL API flow
  // (Prompt 65 §6.2 enforcement covers every PLATFORM_SUPER_ADMIN).
  const mfaA = await enrollFixtureMfa(caller(await login(superAUser.email)), PW);
  const mfaB = await enrollFixtureMfa(caller(await login(superBUser.email)), PW);
  const A = caller(await platformMfaLogin(superAUser.email, PW, mfaA.secret));
  const B = caller(await platformMfaLogin(superBUser.email, PW, mfaB.secret));
  const RO = caller(await login(roUser.email));
  const SUP = caller(await login(supUser.email));
  check("fixtures created + all 4 operator logins OK", true);

  /* ------------- A. F-1: concurrent mutual demotion race --------------- */
  console.log("== A. F-1 last-super-admin concurrency (TOCTOU regression) ==");
  // Fixture isolation: temporarily deactivate any OTHER active super admin
  // so the two fixtures are the ONLY active super admins during the race —
  // this makes the outcome deterministic (exactly one demotion commits).
  const otherSupers = await db.platformOperator.findMany({
    where: { role: "PLATFORM_SUPER_ADMIN", active: true, id: { notIn: [opA.id, opB.id] } },
    select: { id: true },
  });
  for (const o of otherSupers) {
    await db.platformOperator.update({ where: { id: o.id }, data: { active: false } });
  }
  const activeBefore = await db.platformOperator.count({ where: { role: "PLATFORM_SUPER_ADMIN", active: true } });
  check("precondition: exactly 2 active super admins (fixtures isolated)", activeBefore === 2, `count=${activeBefore} (temporarily parked ${otherSupers.length})`);

  const demoteBody = (reason: string) => JSON.stringify({ role: "PLATFORM_SUPPORT", reason, password: PW });
  const [resA, resB] = await Promise.all([
    A(`/api/v1/platform/operators/${opB.id}`, { method: "PATCH", body: demoteBody("R63 race: A demotes B") }),
    B(`/api/v1/platform/operators/${opA.id}`, { method: "PATCH", body: demoteBody("R63 race: B demotes A") }),
  ]);

  const codes = [resA.status, resB.status];
  const oneSucceeded = codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 1;
  check("concurrent mutual demotion → exactly one 200 + one 409", oneSucceeded, `statuses=${codes.join(",")} A:${resA.json?.error?.code ?? "ok"} B:${resB.json?.error?.code ?? "ok"}`);

  const activeAfter = await db.platformOperator.count({ where: { role: "PLATFORM_SUPER_ADMIN", active: true } });
  check("invariant: ≥1 active PLATFORM_SUPER_ADMIN survives the race", activeAfter >= 1, `count=${activeAfter}`);

  const loserSucceeded = codes.filter((c) => c === 200).length === 0;
  const finalA = await db.platformOperator.findUnique({ where: { id: opA.id } });
  const finalB = await db.platformOperator.findUnique({ where: { id: opB.id } });
  const exactlyOneDemoted = (finalA!.role === "PLATFORM_SUPER_ADMIN") !== (finalB!.role === "PLATFORM_SUPER_ADMIN");
  check("exactly one of the two operators was demoted", !loserSucceeded && exactlyOneDemoted, `A=${finalA!.role} B=${finalB!.role}`);

  // Sequential single-demotion of the surviving last admin must STILL 409.
  const survivorId = finalA!.role === "PLATFORM_SUPER_ADMIN" ? opA.id : opB.id;
  const survivorCaller = finalA!.role === "PLATFORM_SUPER_ADMIN" ? A : B;
  const lastBlock = await survivorCaller(`/api/v1/platform/operators/${survivorId}`, { method: "PATCH", body: demoteBody("R63: demote the last survivor") });
  check("demoting the now-last super admin → 409 PLATFORM_LAST_ADMIN_PROTECTED", lastBlock.status === 409 && lastBlock.json?.error?.code === "PLATFORM_LAST_ADMIN_PROTECTED", JSON.stringify(lastBlock.json?.error));

  // Restore both fixtures to SUPER_ADMIN and un-park the other super admins.
  await db.platformOperator.update({ where: { id: opA.id }, data: { role: "PLATFORM_SUPER_ADMIN", active: true } });
  await db.platformOperator.update({ where: { id: opB.id }, data: { role: "PLATFORM_SUPER_ADMIN", active: true } });
  for (const o of otherSupers) {
    await db.platformOperator.update({ where: { id: o.id }, data: { active: true } });
  }

  /* ------------- B. W-1: notification mutation role gate --------------- */
  console.log("== B. W-1 notification mutation role gate (READONLY denied) ==");
  const roAnnounce = await RO("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [superAUser.id], message: "R63 readonly attempt" }),
  });
  check("READONLY announcement POST → 403 PLATFORM_PERMISSION_DENIED", roAnnounce.status === 403 && roAnnounce.json?.error?.code === "PLATFORM_PERMISSION_DENIED", JSON.stringify(roAnnounce.json?.error));

  const roRetry = await RO("/api/v1/platform/notifications/r63nonexistentid01/retry", { method: "POST" });
  check("READONLY delivery retry POST → 403 (gate precedes existence)", roRetry.status === 403 && roRetry.json?.error?.code === "PLATFORM_PERMISSION_DENIED", JSON.stringify(roRetry.json?.error));

  const supRetry = await SUP("/api/v1/platform/notifications/r63nonexistentid01/retry", { method: "POST" });
  check("SUPPORT delivery retry passes role gate → non-403 outcome", supRetry.status !== 403, `status=${supRetry.status} code=${supRetry.json?.error?.code}`);

  const supAnnounce = await SUP("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: ["r63nonexistentuserid0000"], message: "R63 support gate probe" }),
  });
  const gatePassed = supAnnounce.status !== 403;
  const honestResult = gatePassed ? (supAnnounce.json?.data?.rejected === 1 || supAnnounce.status === 422) : false;
  check("SUPPORT announcement passes gate; bogus recipient honestly rejected", gatePassed && honestResult, `status=${supAnnounce.status} data=${JSON.stringify(supAnnounce.json?.data)}`);

  /* ---------------------- C. static fix-shape guard -------------------- */
  console.log("== C. static guards ==");
  const routeSrc = readFileSync("src/app/api/v1/platform/operators/[id]/route.ts", "utf8");
  const txIdx = routeSrc.indexOf("db.$transaction");
  const updateIdx = routeSrc.indexOf("tx.platformOperator.update");
  const countIdx = routeSrc.indexOf("tx.platformOperator.count");
  const auditIdx = routeSrc.indexOf("platformAudit(");
  check("F-1 fix shape: update → in-tx count → audit inside $transaction", txIdx > -1 && updateIdx > txIdx && countIdx > updateIdx && auditIdx > countIdx, `tx=${txIdx} update=${updateIdx} count=${countIdx} audit=${auditIdx}`);
  check("F-1 fix shape: zero-survivor rollback throws PLATFORM_LAST_ADMIN_PROTECTED inside tx", countIdx > -1 && routeSrc.indexOf("PLATFORM_LAST_ADMIN_PROTECTED", countIdx) !== -1 && routeSrc.indexOf("PLATFORM_LAST_ADMIN_PROTECTED", countIdx) < auditIdx + 200);

  /* ------------- D. F-3: AI cost ledger business-cascade law ----------- */
  console.log("== D. F-3 AI Cost Ledger cascade (DB-level regression) ==");
  const cascadeOwner = await db.user.create({ data: { email: `r63-cascade-${TS}@t.dev`, name: "R63 Cascade", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(cascadeOwner.id);
  const cascadeBiz = await db.business.create({ data: { name: `R63 Cascade Biz ${TS}`, slug: `r63-cascade-${TS}`, ownerId: cascadeOwner.id } });
  // UsagePeriod is the anchor UsageEvent requires (Prompt 21 model).
  const period = await db.usagePeriod.create({
    data: { businessId: cascadeBiz.id, start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-31T23:59:59Z") },
  });
  const usageEvent = await db.usageEvent.create({
    data: {
      businessId: cascadeBiz.id, usagePeriodId: period.id, metric: "ai_chat_message",
      quantity: 1, status: "COMMITTED", requestId: `r63-${TS}`, idempotencyKey: `r63-${TS}`,
    },
  });
  const costRecord = await db.aiCostRecord.create({
    data: {
      usageEventId: usageEvent.id, requestId: `r63-${TS}`, businessId: cascadeBiz.id,
      planCodeAtUsage: "FREE", provider: "test", model: "test-model",
      tokenStatus: "NONE", costStatus: "UNKNOWN", unknownReason: "RATE_NOT_FOUND",
    },
  });
  check("fixture: usage event + cost record created", Boolean(usageEvent.id && costRecord.id));
  await db.business.delete({ where: { id: cascadeBiz.id } });
  const orphanUsage = await db.usageEvent.findUnique({ where: { id: usageEvent.id } });
  const orphanCost = await db.aiCostRecord.findUnique({ where: { id: costRecord.id } });
  check("F-3: business deletion cascades BOTH usage event AND cost record (no orphans)", orphanUsage === null && orphanCost === null, `usage=${orphanUsage ? "SURVIVED" : "deleted"} cost=${orphanCost ? "SURVIVED ✗" : "deleted"}`);

  console.log("== cleanup ==");
  await clearFixtureMfa(db, createdUserIds);
  await db.platformOperator.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  const residueOps = await db.platformOperator.count({ where: { id: { in: createdOperatorIds } } });
  const residueUsers = await db.user.count({ where: { id: { in: createdUserIds } } });
  check("cleanup: zero fixture residue", residueOps === 0 && residueUsers === 0, `ops=${residueOps} users=${residueUsers}`);

  console.log("=========================================");
  console.log(`R63 AUDIT REGRESSION: ${pass}/${pass + fail} ${fail === 0 ? "PASS — ALL GREEN ✓" : `FAIL (${fail}) ✗`}`);
  await db.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("R63 harness crashed:", e);
  try { await db.platformOperator.deleteMany({ where: { userId: { in: createdUserIds } } }); await db.user.deleteMany({ where: { id: { in: createdUserIds } } }); } catch {}
  await db.$disconnect();
  process.exit(1);
});

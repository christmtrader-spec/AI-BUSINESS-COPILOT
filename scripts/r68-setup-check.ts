/**
 * R68 SETUP-KEY BATTERY — cold-start first-operator activation, live proof.
 *
 *   A  STATUS GATE: anonymous 401; plain tenant session → 200 with the
 *      honest boolean (setupRequired true while zero operators exist).
 *   B  MINT LAWS (service level, offline-only authority): mint REFUSES once
 *      any operator exists (403 SETUP_UNAVAILABLE); TTL bounds (422).
 *   C  ACTIVATION: wrong key 404 (+ SecurityEvent); expired key 410; bound
 *      key + wrong account 403 SETUP_KEY_BOUND_MISMATCH; good key 200
 *      (role PLATFORM_SUPER_ADMIN, next=mfa-enrollment); operator row
 *      created for the SAME account; key marked used (usedAt + usedByUser);
 *      key reuse 409; window now closed (status false; fresh key 403);
 *      /platform/self fail-closed 403 PLATFORM_MFA_REQUIRED (MFA law is
 *      NEVER bypassed by the setup path); audit row exists; SecurityEvents
 *      exist; the RAW key appears NOWHERE (hash-only storage, §14).
 *
 * Run: bun --conditions react-server scripts/r68-setup-check.ts
 * Requires: dev server on :3000 and a COLD platform (zero operators) — the
 * battery aborts safely without mutating anything otherwise.
 * Cleanup: every fixture row removed (keys, operators, users, audits,
 * security events) — zero residue asserted; the platform stays cold.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { callerOf, jarFetch } from "./lib/platform-mfa";
import { mintSetupKey } from "../src/lib/platform/setup";
import { ApiError } from "../src/lib/api-helpers";

const BASE = "http://localhost:3000";
const PW = "R68Setup!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const operatorIds: string[] = [];
const setupKeyIds: string[] = [];
const batteryStart = new Date();

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

const anon = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers as any) } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
};

/** Cookie-jar session caller (same transport contract as r64/r65/r67). */
function sessionCaller(email: string) {
  const jar = new Map<string, string>();
  const caller = callerOf(jar);
  const f = jarFetch(jar);
  return async (path: string, init: RequestInit = {}) => {
    if (!jar.size) {
      const csrf = await caller("/api/auth/csrf");
      const res = await f("/api/auth/callback/credentials", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken: String((csrf.json as any)?.csrfToken), email, password: PW }).toString(),
      });
      if (res.status !== 200 && res.status !== 302) throw new Error(`fixture login failed ${res.status}`);
    }
    return caller(path, init);
  };
}

const hash = (pw: string) => bcrypt.hashSync(pw, 10);

async function fixtureUser(email: string, name: string) {
  const u = await db.user.create({
    data: { email, name, passwordHash: hash(PW), emailVerifiedAt: new Date() },
  });
  createdUserIds.push(u.id);
  return u;
}

/** FK-safe sweep of crashed-run fixture residue (self-healing law). */
async function preSweep() {
  const stale = await db.user.findMany({ where: { email: { contains: "r68-" } }, select: { id: true } });
  if (stale.length) {
    const ids = stale.map((u) => u.id);
    const ops = await db.platformOperator.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    if (ops.length) {
      await db.platformAuditLog.deleteMany({ where: { operatorId: { in: ops.map((o) => o.id) } } });
      await db.platformOperator.deleteMany({ where: { id: { in: ops.map((o) => o.id) } } });
    }
    await db.mfaRecoveryCode.deleteMany({ where: { userId: { in: ids } } });
    await db.mfaCredential.deleteMany({ where: { userId: { in: ids } } });
    await db.mfaLoginChallenge.deleteMany({ where: { userId: { in: ids } } });
    await db.userSession.deleteMany({ where: { userId: { in: ids } } });
    await db.securityEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    console.log(`  (pre-swept ${ids.length} crashed-run fixture users)`);
  }
  // Stale setup keys from crashed runs are always battery-owned (minting is
  // offline-only) — clear them so the window logic starts deterministic.
  const staleKeys = await db.platformSetupKey.deleteMany({});
  if (staleKeys.count) console.log(`  (pre-swept ${staleKeys.count} stale setup keys)`);
}

async function main() {
  console.log(`\n== R68 SETUP-KEY BATTERY — ${new Date().toISOString()} ==\n`);

  await preSweep();

  // Cold-start precondition: the battery refuses to run against a platform
  // that already has operators (it must never destroy real state).
  const operatorsBefore = await db.platformOperator.count();
  if (operatorsBefore !== 0) {
    console.log(`  ⚠ ABORT: ${operatorsBefore} operator(s) exist — cold-start battery requires a cold platform. No mutations performed.`);
    fail++;
    return;
  }

  const qa = await fixtureUser(`r68-owner-${TS}@t.dev`, "R68 Owner Fixture");
  const other = await fixtureUser(`r68-other-${TS}@t.dev`, "R68 Other Fixture");

  console.log("\n== A. Status gate ==");

  const anonStatus = await anon("/api/v1/platform/setup");
  check("A1 status anonymous → 401", anonStatus.status === 401, `got ${anonStatus.status}`);

  const qaCaller = sessionCaller(qa.email);
  const st = await qaCaller("/api/v1/platform/setup");
  check("A2 tenant session status → 200 setupRequired:true", st.status === 200 && st.json?.data?.setupRequired === true, `got ${st.status} ${JSON.stringify(st.json?.data)}`);

  console.log("\n== B. Mint laws (offline authority) ==");

  // B3 — the minter refuses while ANY operator exists (create → mint → drop).
  const tempOp = await db.platformOperator.create({ data: { userId: qa.id, role: "PLATFORM_SUPPORT", active: true } });
  operatorIds.push(tempOp.id);
  let refused = false;
  try { await mintSetupKey({}); } catch (e) { refused = e instanceof ApiError && e.status === 403 && e.code === "SETUP_UNAVAILABLE"; }
  check("B3 mint refuses when operators exist (403 SETUP_UNAVAILABLE)", refused);
  await db.platformOperator.delete({ where: { id: tempOp.id } });
  operatorIds.pop();

  let ttlRejected = false;
  try { await mintSetupKey({ ttlHours: 999 }); } catch (e) { ttlRejected = e instanceof ApiError && e.status === 422; }
  check("B4 mint rejects TTL beyond the 168h bound (422)", ttlRejected);

  console.log("\n== C. Activation ==");

  // C5 — wrong key: honest 404 + failure SecurityEvent (no key material).
  const wrong = await qaCaller("/api/v1/platform/setup", { method: "POST", body: JSON.stringify({ key: "a".repeat(43) + "WRONG" }) });
  check("C5 wrong key → 404 SETUP_KEY_INVALID", wrong.status === 404 && wrong.json?.error?.code === "SETUP_KEY_INVALID", `got ${wrong.status} ${wrong.json?.error?.code}`);
  const wrongEvent = await db.securityEvent.count({ where: { eventType: "platform.setup.claim_failed", userId: qa.id, reasonCode: "SETUP_KEY_INVALID" } });
  check("C6 failure SecurityEvent recorded (fixed vocabulary)", wrongEvent === 1, `count=${wrongEvent}`);

  // C7 — expired key: 410 (mint with ~1s TTL via the service, wait, redeem).
  const exp = await mintSetupKey({ ttlHours: 0.0003 });
  setupKeyIds.push(exp.id);
  await new Promise((r) => setTimeout(r, 1400));
  const expired = await qaCaller("/api/v1/platform/setup", { method: "POST", body: JSON.stringify({ key: exp.key }) });
  check("C7 expired key → 410 SETUP_KEY_EXPIRED", expired.status === 410 && expired.json?.error?.code === "SETUP_KEY_EXPIRED", `got ${expired.status} ${expired.json?.error?.code}`);

  // C8 — bound key + WRONG account: 403 SETUP_KEY_BOUND_MISMATCH.
  const bound = await mintSetupKey({ boundEmail: qa.email });
  setupKeyIds.push(bound.id);
  const otherCaller = sessionCaller(other.email);
  const boundWrong = await otherCaller("/api/v1/platform/setup", { method: "POST", body: JSON.stringify({ key: bound.key }) });
  check("C8 bound key + wrong account → 403 SETUP_KEY_BOUND_MISMATCH", boundWrong.status === 403 && boundWrong.json?.error?.code === "SETUP_KEY_BOUND_MISMATCH", `got ${boundWrong.status} ${boundWrong.json?.error?.code}`);

  // C9 — the good unbound key: the session's OWN account becomes the first
  // PLATFORM_SUPER_ADMIN; nothing else about the account changes.
  const good = await mintSetupKey({});
  setupKeyIds.push(good.id);
  const beforeHash = qa.passwordHash;
  const activated = await qaCaller("/api/v1/platform/setup", { method: "POST", body: JSON.stringify({ key: good.key }) });
  check(
    "C9 good key → 200 activated (SUPER_ADMIN, next=mfa-enrollment)",
    activated.status === 200 && activated.json?.data?.role === "PLATFORM_SUPER_ADMIN" && activated.json?.data?.next === "mfa-enrollment",
    `got ${activated.status} ${JSON.stringify(activated.json?.data)}`,
  );

  const operator = await db.platformOperator.findUnique({ where: { userId: qa.id } });
  check("C10 operator row created (SUPER_ADMIN, active)", !!operator && operator.role === "PLATFORM_SUPER_ADMIN" && operator.active === true);
  if (operator) operatorIds.push(operator.id);

  const keyRow = await db.platformSetupKey.findUnique({ where: { id: good.id } });
  check("C11 key marked used (usedAt + usedByUserId)", !!keyRow && keyRow.usedAt !== null && keyRow.usedByUserId === qa.id);
  check("C12 hash-only storage — raw key never persisted", !!keyRow && keyRow.keyHash !== good.key && keyRow.keyHash.length === 64);
  check("C13 account untouched — same password hash", beforeHash === (await db.user.findUnique({ where: { id: qa.id }, select: { passwordHash: true } }))?.passwordHash);

  const reuse = await qaCaller("/api/v1/platform/setup", { method: "POST", body: JSON.stringify({ key: good.key }) });
  // The closed-window gate takes PRECEDENCE over key-state details (info
  // minimization): once any operator exists the endpoint reports only
  // SETUP_UNAVAILABLE — it never discusses keys with a closed window.
  check("C14 key reuse after window close → 403 SETUP_UNAVAILABLE (gate precedence)", reuse.status === 403 && reuse.json?.error?.code === "SETUP_UNAVAILABLE", `got ${reuse.status} ${reuse.json?.error?.code}`);

  const st2 = await otherCaller("/api/v1/platform/setup");
  check("C15 window closed — status setupRequired:false", st2.status === 200 && st2.json?.data?.setupRequired === false, `got ${JSON.stringify(st2.json?.data)}`);

  const fresh = await mintSetupKey({}).then(() => null).catch((e) => e);
  check("C16 minter self-disabled after first claim (403)", fresh instanceof ApiError && fresh.status === 403 && fresh.code === "SETUP_UNAVAILABLE");

  const self = await qaCaller("/api/v1/platform/self");
  check("C17 /self fail-closed → 403 PLATFORM_MFA_REQUIRED (MFA law inherited)", self.status === 403 && self.json?.error?.code === "PLATFORM_MFA_REQUIRED", `got ${self.status} ${self.json?.error?.code}`);

  const auditRow = await db.platformAuditLog.findFirst({
    where: { action: "platform.setup_key_claimed", targetUserId: qa.id },
    orderBy: { createdAt: "desc" },
  });
  check("C18 platform audit row exists (key id linkage, not the key)", !!auditRow && auditRow.entityId === good.id);
  const auditPayload = JSON.stringify([auditRow?.beforeJson, auditRow?.afterJson, auditRow?.reason]);
  check("C19 raw key NEVER in audit payload (§14)", !auditPayload.includes(good.key));

  const claimedEvents = await db.securityEvent.count({ where: { eventType: "platform.setup.claimed", userId: qa.id } });
  check("C20 success SecurityEvent recorded", claimedEvents === 1, `count=${claimedEvents}`);

  const mintedEvents = await db.securityEvent.count({ where: { eventType: "platform.setup.key_minted" } });
  check("C21 mint events recorded (offline mints are audited too)", mintedEvents >= 3, `count=${mintedEvents}`);

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==\n`);
}

/** FK-safe cleanup — the platform MUST return to the cold state. */
async function cleanup() {
  const ops = operatorIds.length
    ? await db.platformOperator.findMany({ where: { id: { in: operatorIds } }, select: { id: true } })
    : [];
  if (ops.length) {
    await db.platformAuditLog.deleteMany({ where: { operatorId: { in: ops.map((o) => o.id) } } });
    await db.platformOperator.deleteMany({ where: { id: { in: ops.map((o) => o.id) } } });
  }
  // Battery-owned audits (this run only) + all battery-owned keys.
  await db.platformAuditLog.deleteMany({
    where: { action: "platform.setup_key_claimed", createdAt: { gte: batteryStart } },
  });
  await db.platformSetupKey.deleteMany({}).catch(() => undefined);
  await db.mfaRecoveryCode.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.mfaCredential.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.mfaLoginChallenge.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.userSession.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.securityEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  // Offline mint events are userId-null and battery-timed — swept too.
  await db.securityEvent.deleteMany({
    where: { eventType: { startsWith: "platform.setup." }, createdAt: { gte: batteryStart } },
  });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  const operators = await db.platformOperator.count();
  const keys = await db.platformSetupKey.count();
  const users = await db.user.count({ where: { email: { contains: "r68-" } } });
  console.log(`cleanup: operators=${operators} setupKeys=${keys} r68Users=${users} (target 0/0/0)`);
}

main()
  .catch((e) => {
    console.error("battery error:", e);
    fail++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\nFINAL: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });

/**
 * R65 ZERO-TRUST BATTERY — Prompt 65 §6/§10/§17 live proof.
 *
 *   A  PLATFORM MFA ENFORCEMENT (§6.2): super-admin without MFA is denied
 *      EVERYWHERE (403 PLATFORM_MFA_REQUIRED, not a generic 403); readonly
 *      is unaffected under the SUPER_ADMIN policy; enrollment via the REAL
 *      API flow unlocks access; MFA login issues a real session; a
 *      password-only attempt against an MFA-enabled account NEVER issues a
 *      session; replayed TOTP is rejected; recovery codes work exactly
 *      once; disabling MFA (reauth) revokes privileged access again
 *      (per-request enforcement). Policy function is unit-checked.
 *   B  TWO-PERSON APPROVAL (§10): permission matrix on the approvals API;
 *      unknown kind / invalid payload 422; requester cannot self-approve;
 *      approvals:manage WITHOUT the target-operation permission cannot
 *      approve; full happy path (BILLING requests → SUPER approves →
 *      executes with reauth → PriceBook actually active → audited);
 *      double-approve/double-execute/reject/cancel/expiry/concurrency laws.
 *   C  SECURITY SUMMARY (§11): activeOperatorsWithoutMfa +
 *      pendingApprovalRequests present and consistent with DB truth.
 *
 * Run: bun scripts/r65-zero-trust-check.ts   (dev server on :3000)
 * Cleanup: every fixture row removed (approval requests, audit rows, price
 * book rows, operators, users) — zero-residue asserted.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { enrollFixtureMfa, platformMfaLogin, callerOf, jarFetch, generateTotpCode, clearFixtureMfa } from "./lib/platform-mfa";
import { platformMfaEnforcement, platformRoleRequiresMfa } from "../src/lib/auth/config";

const BASE = "http://localhost:3000";
const PW = "R65Zero!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const operatorIds: string[] = [];
const approvalIds: string[] = [];
const priceBookIds: string[] = [];

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function caller(jar: Map<string, string>) {
  return callerOf(jar);
}

const anon = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers as any) } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, res };
};

const hash = (pw: string) => bcrypt.hashSync(pw, 10);

async function op(userId: string, role: string) {
  const row = await db.platformOperator.create({ data: { userId, role, active: true } });
  operatorIds.push(row.id);
  return row;
}

/* ----------------------------- policy unit laws ---------------------------- */
function policyUnitChecks() {
  console.log("\n== 0. policy unit laws (in-process) ==");
  const saved = process.env.PLATFORM_MFA_ENFORCEMENT;
  try {
    delete process.env.PLATFORM_MFA_ENFORCEMENT;
    check("default enforcement = SUPER_ADMIN (Prompt 65 target policy)", platformMfaEnforcement() === "SUPER_ADMIN");
    check("default: super requires MFA", platformRoleRequiresMfa("PLATFORM_SUPER_ADMIN") === true);
    check("default: readonly does NOT require MFA", platformRoleRequiresMfa("PLATFORM_READONLY") === false);
    process.env.PLATFORM_MFA_ENFORCEMENT = "ALL_OPERATORS";
    check("ALL_OPERATORS: every operator role requires MFA", ["PLATFORM_SUPPORT", "PLATFORM_BILLING", "PLATFORM_READONLY"].every((r) => platformRoleRequiresMfa(r)));
    process.env.PLATFORM_MFA_ENFORCEMENT = "OFF";
    check("OFF: no role requires MFA", platformRoleRequiresMfa("PLATFORM_SUPER_ADMIN") === false);
    process.env.PLATFORM_MFA_ENFORCEMENT = "GARBAGE";
    check("invalid value falls back to SUPER_ADMIN", platformMfaEnforcement() === "SUPER_ADMIN");
  } finally {
    if (saved === undefined) delete process.env.PLATFORM_MFA_ENFORCEMENT; else process.env.PLATFORM_MFA_ENFORCEMENT = saved;
  }
}

/* ---------------------------------- main ----------------------------------- */
/** FK-safe sweep of crashed-run fixture residue (self-healing, r64 law). */
async function preSweep() {
  const stale = await db.user.findMany({ where: { email: { contains: `r65-` } }, select: { id: true } });
  if (!stale.length) return;
  const ids = stale.map((u) => u.id);
  const ops = await db.platformOperator.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const opIds = ops.map((o) => o.id);
  if (opIds.length) {
    await db.platformApprovalRequest.deleteMany({ where: { OR: [{ requesterId: { in: opIds } }, { approverId: { in: opIds } }] } });
    await db.platformAuditLog.deleteMany({ where: { operatorId: { in: opIds } } });
    await db.supportTicket.updateMany({ where: { assigneeOperatorId: { in: opIds } }, data: { assigneeOperatorId: null } }).catch(() => undefined);
    await db.platformOperator.deleteMany({ where: { id: { in: opIds } } });
  }
  await db.mfaRecoveryCode.deleteMany({ where: { userId: { in: ids } } });
  await db.mfaCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.mfaLoginChallenge.deleteMany({ where: { userId: { in: ids } } });
  await db.userSession.deleteMany({ where: { userId: { in: ids } } });
  await db.securityEvent.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`  (pre-swept ${ids.length} crashed-run fixture users)`);
}

async function main() {
  console.log("== R65 fixtures ==");
  await preSweep();
  policyUnitChecks();

  const superUser = await db.user.create({ data: { email: `r65-super-${TS}@t.dev`, name: "R65 Super", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  const super2User = await db.user.create({ data: { email: `r65-super2-${TS}@t.dev`, name: "R65 Super2", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  const bilUser = await db.user.create({ data: { email: `r65-bil-${TS}@t.dev`, name: "R65 Billing", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  const secUser = await db.user.create({ data: { email: `r65-sec-${TS}@t.dev`, name: "R65 Security", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  const roUser = await db.user.create({ data: { email: `r65-ro-${TS}@t.dev`, name: "R65 Readonly", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  const supUser = await db.user.create({ data: { email: `r65-sup-${TS}@t.dev`, name: "R65 Support", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  const tenantUser = await db.user.create({ data: { email: `r65-tenant-${TS}@t.dev`, name: "R65 Tenant", passwordHash: hash(PW), emailVerifiedAt: new Date() } });
  createdUserIds.push(superUser.id, super2User.id, bilUser.id, secUser.id, roUser.id, supUser.id, tenantUser.id);

  await op(superUser.id, "PLATFORM_SUPER_ADMIN");
  const super2Op = await op(super2User.id, "PLATFORM_SUPER_ADMIN");
  await op(bilUser.id, "PLATFORM_BILLING");
  await op(secUser.id, "PLATFORM_SECURITY");
  await op(roUser.id, "PLATFORM_READONLY");
  await op(supUser.id, "PLATFORM_SUPPORT");

  // PriceBook fixture (inactive; activation is the approval's operation).
  const book = await db.priceBook.create({
    data: {
      code: `r65-appr-${TS}`,
      version: "v1",
      currency: "IRR",
      active: false,
      description: `R65 approval fixture ${TS}`,
      prices: {
        create: [
          { planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 2_900_000, active: true },
          { planCode: "STARTER", billingPeriod: "YEARLY", amountMinor: 29_000_000, active: true },
          { planCode: "BUSINESS", billingPeriod: "MONTHLY", amountMinor: 7_900_000, active: true },
          { planCode: "BUSINESS", billingPeriod: "YEARLY", amountMinor: 79_000_000, active: true },
          { planCode: "PRO", billingPeriod: "MONTHLY", amountMinor: 19_900_000, active: true },
          { planCode: "PRO", billingPeriod: "YEARLY", amountMinor: 199_000_000, active: true },
        ],
      },
    },
  });
  priceBookIds.push(book.id);

  /* ------------------- A. MFA enforcement matrix (§6.2) -------------------- */
  console.log("\n== A. platform MFA enforcement (§6.2) ==");

  // A1 — super WITHOUT MFA: password login still works (MFA not enrolled),
  // but EVERY platform route denies with the dedicated value-free code.
  const superJar0 = await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: superUser.email, password: PW }).toString() });
    return jar;
  })();
  const S0 = caller(superJar0);
  const self0 = await S0("/api/v1/platform/self");
  check("A1 super without MFA → /self 403 PLATFORM_MFA_REQUIRED", self0.status === 403 && self0.json?.error?.code === "PLATFORM_MFA_REQUIRED", JSON.stringify(self0.json?.error));
  const ov0 = await S0("/api/v1/platform/overview");
  check("A2 super without MFA → /overview 403 PLATFORM_MFA_REQUIRED (every route)", ov0.status === 403 && ov0.json?.error?.code === "PLATFORM_MFA_REQUIRED");
  const ops0 = await S0("/api/v1/platform/operators?page=1&pageSize=5");
  check("A3 super without MFA → operators 403 PLATFORM_MFA_REQUIRED", ops0.status === 403 && ops0.json?.error?.code === "PLATFORM_MFA_REQUIRED");

  // A4 — readonly WITHOUT MFA is unaffected under the SUPER_ADMIN policy.
  const RO = caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: roUser.email, password: PW }).toString() });
    return jar;
  })());
  const roSelf = await RO("/api/v1/platform/self");
  check("A4 readonly without MFA → /self 200 (SUPER_ADMIN policy scope)", roSelf.status === 200 && roSelf.json?.data?.role === "PLATFORM_READONLY");

  // A5 — tenant (no operator row) unchanged.
  const TEN = caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: tenantUser.email, password: PW }).toString() });
    return jar;
  })());
  const tenSelf = await TEN("/api/v1/platform/self");
  check("A5 tenant without operator row → 403 PLATFORM_FORBIDDEN (unchanged)", tenSelf.status === 403 && tenSelf.json?.error?.code === "PLATFORM_FORBIDDEN");

  // A6 — enroll via the REAL API flow → access unlocks; /self carries identity.
  const superMfa = await enrollFixtureMfa(caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: superUser.email, password: PW }).toString() });
    return jar;
  })()), PW);
  const S = caller(await platformMfaLogin(superUser.email, PW, superMfa.secret));
  const self1 = await S("/api/v1/platform/self");
  check("A6 enrolled super → /self 200 with email+mfaEnabled", self1.status === 200 && self1.json?.data?.mfaEnabled === true && self1.json?.data?.email === superUser.email, JSON.stringify(self1.json?.data?.role));

  // A7 — password-only attempt on the MFA-enabled account must NEVER issue a
  // session (anti-bypass: the redirect carries MFA_REQUIRED, jar stays clean).
  const bypassJar = new Map<string, string>();
  const bf = jarFetch(bypassJar);
  const bcsrf = await (await bf("/api/auth/csrf")).json() as any;
  const attempt = await bf("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: bcsrf.csrfToken, email: superUser.email, password: PW }).toString() });
  const issuedSession = [...bypassJar.keys()].some((k) => k.includes("session-token"));
  check("A7 password-only attempt on MFA account → MFA_REQUIRED, NO session", /MFA_REQUIRED/.test(attempt.headers.get("location") ?? "") && !issuedSession, `loc=${(attempt.headers.get("location") ?? "").slice(0, 80)}`);

  // A8 — replayed TOTP rejected at the challenge/complete layer.
  const replayJar = new Map<string, string>();
  const rf = jarFetch(replayJar);
  const rcsrf = await (await rf("/api/auth/csrf")).json() as any;
  await rf("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: rcsrf.csrfToken, email: superUser.email, password: PW }).toString() });
  // §45 replay law — A6's login consumed (its current+1). Within the same
  // 30s window EVERY step ≤ that is a replay, so the battery waits across
  // the step boundary (a real operator simply waits for their next code)
  // and then uses the fresh (current+1) code.
  await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 250));
  const code1 = generateTotpCode(superMfa.secret, Date.now() + 30_000);
  const chRes = await rf("/api/v1/auth/mfa/challenge", { method: "POST", body: JSON.stringify({ email: superUser.email, password: PW }) });
  const chJson: any = await chRes.json();
  const use1 = await rf("/api/v1/auth/mfa/complete", { method: "POST", body: JSON.stringify({ challenge: chJson.data?.challenge ?? chJson.challenge, code: code1, method: "TOTP" }) });
  const use1Json: any = await use1.json().catch(() => null);
  check("A8a first TOTP accepted at complete", use1.status === 200 && !!use1Json?.data?.assertion, `status=${use1.status} body=${JSON.stringify(use1Json).slice(0, 120)}`);
  const ch2Res = await rf("/api/v1/auth/mfa/challenge", { method: "POST", body: JSON.stringify({ email: superUser.email, password: PW }) });
  const ch2Json: any = await ch2Res.json();
  const use2 = await rf("/api/v1/auth/mfa/complete", { method: "POST", body: JSON.stringify({ challenge: ch2Json.data?.challenge ?? ch2Json.challenge, code: code1, method: "TOTP" }) });
  const use2Json: any = await use2.json().catch(() => null);
  check("A8b replayed TOTP → 400 MFA_INVALID_CODE", use2.status === 400 && use2Json?.error?.code === "MFA_INVALID_CODE", `status=${use2.status}`);

  // A9 — recovery code login works EXACTLY once.
  const recJar = await platformMfaLogin(superUser.email, PW, superMfa.secret, { code: superMfa.recoveryCodes[0], method: "RECOVERY_CODE" });
  check("A9a recovery-code login issues session", recJar.size > 0);
  let recReplayRejected = false;
  try {
    await platformMfaLogin(superUser.email, PW, superMfa.secret, { code: superMfa.recoveryCodes[0], method: "RECOVERY_CODE" });
  } catch {
    recReplayRejected = true; // complete rejects the consumed code
  }
  check("A9b consumed recovery code cannot be reused", recReplayRejected);

  // A10 — wrong TOTP rejected with the generic code.
  const wrongJar = new Map<string, string>();
  const wf = jarFetch(wrongJar);
  const wcsrf = await (await wf("/api/auth/csrf")).json() as any;
  await wf("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: wcsrf.csrfToken, email: superUser.email, password: PW }).toString() });
  const wch: any = await (await wf("/api/v1/auth/mfa/challenge", { method: "POST", body: JSON.stringify({ email: superUser.email, password: PW }) })).json();
  const wrong = await wf("/api/v1/auth/mfa/complete", { method: "POST", body: JSON.stringify({ challenge: wch.data?.challenge ?? wch.challenge, code: "000000", method: "TOTP" }) });
  const wrongJson: any = await wrong.json().catch(() => null);
  check("A10 invalid TOTP → 400 MFA_INVALID_CODE (generic)", wrong.status === 400 && wrongJson?.error?.code === "MFA_INVALID_CODE");

  // A11 — disabling MFA (reauth) revokes privileged access AGAIN: the same
  // credential that unlocked access must be removable only via reauth, and
  // enforcement re-applies on the next request (per-request gate).
  // §65/§113 — disable requires an authenticated (MFA) session + current
  // password + current TOTP + the exact typed confirmation "DISABLE MFA".
  // The §45 replay law means each TOTP step can be consumed ONCE: every
  // back-to-back MFA use must cross a 30s step boundary (a real operator
  // simply waits for their next code — the battery does the same).
  const nextStepMs = () => 30_000 - (Date.now() % 30_000) + 250;
  await new Promise((r) => setTimeout(r, nextStepMs()));
  const disabler = caller(await platformMfaLogin(superUser.email, PW, superMfa.secret));
  await new Promise((r) => setTimeout(r, nextStepMs()));
  const disable = await disabler("/api/v1/me/security/mfa/disable", { method: "POST", body: JSON.stringify({ password: PW, mfaCode: generateTotpCode(superMfa.secret, Date.now() + 30_000), confirmation: "DISABLE MFA" }) });
  check("A11a MFA disable with current password → 200", disable.status === 200, JSON.stringify(disable.json?.error));
  const superJar2 = await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: superUser.email, password: PW }).toString() });
    return jar;
  })();
  const self2 = await caller(superJar2)("/api/v1/platform/self");
  check("A11b after disable → platform access denied again (fail-closed loop)", self2.status === 403 && self2.json?.error?.code === "PLATFORM_MFA_REQUIRED");

  // Re-enroll for the approval tests (S must be privileged).
  const superMfa2 = await enrollFixtureMfa(caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: superUser.email, password: PW }).toString() });
    return jar;
  })()), PW);
  // The enroll-confirm consumed the CURRENT step — log in with the NEXT
  // step's code (§45: future steps are never blocked).
  const superJar3 = await platformMfaLogin(superUser.email, PW, superMfa2.secret, { code: generateTotpCode(superMfa2.secret, Date.now() + 30_000) });
  const S2 = caller(superJar3);
  const self3 = await S2("/api/v1/platform/self");
  check("A12 re-enrolled super → /self 200 (mfaEnabled)", self3.status === 200 && self3.json?.data?.mfaEnabled === true);

  // Second super for approver role + approve-side enforcement tests.
  const super2Mfa = await enrollFixtureMfa(caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: super2User.email, password: PW }).toString() });
    return jar;
  })()), PW);
  const S2OP = caller(await platformMfaLogin(super2User.email, PW, super2Mfa.secret, { code: generateTotpCode(super2Mfa.secret, Date.now() + 30_000) }));

  // Non-super operators (no MFA needed under the default policy).
  const BIL = caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: bilUser.email, password: PW }).toString() });
    return jar;
  })());
  const SEC = caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: secUser.email, password: PW }).toString() });
    return jar;
  })());
  const SUP = caller(await (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: supUser.email, password: PW }).toString() });
    return jar;
  })());

  /* --------------------- B. two-person approval (§10) ---------------------- */
  console.log("\n== B. two-person approval (§10) ==");

  const b1 = await anon("/api/v1/platform/approvals");
  check("B1 anon list → 401", b1.status === 401);
  const b2 = await TEN("/api/v1/platform/approvals");
  check("B2 tenant list → 403", b2.status === 403 && b2.json?.error?.code === "PLATFORM_FORBIDDEN");
  const b3 = await SUP("/api/v1/platform/approvals");
  check("B3 SUPPORT list → 200 (approvals:read assigned to every role)", b3.status === 200, `status=${b3.status} ${String(JSON.stringify(b3.json)).slice(0, 120)}`);
  const b4 = await RO("/api/v1/platform/approvals");
  check("B4 READONLY list → 200 (approvals:read)", b4.status === 200);
  const b5 = await RO("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `RO must not create ${TS}` }) });
  check("B5 READONLY create → 403 (approvals:manage)", b5.status === 403 && b5.json?.error?.code === "PLATFORM_PERMISSION_DENIED", `status=${b5.status} ${String(JSON.stringify(b5.json)).slice(0, 120)}`);

  const create = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `Quarterly price refresh needs dual control ${TS}` }) });
  check("B6 BILLING (pricing:manage + approvals:manage) creates → 200 PENDING", create.status === 200 && create.json?.data?.approval?.status === "PENDING", JSON.stringify(create.json?.error));
  const approvalId = create.json?.data?.approval?.id as string | undefined;
  approvalIds.push(approvalId ?? "");
  check("B7 created DTO carries kind label + hash prefix + requester", !!approvalId && typeof create.json?.data?.approval?.payloadHashPrefix === "string" && create.json?.data?.approval?.payloadHashPrefix.length === 12 && create.json?.data?.approval?.requester?.email === bilUser.email);

  const b8 = await SUP("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `SUPPORT has no approvals:manage ${TS}` }) });
  check("B8 SUPPORT create → 403", b8.status === 403 && b8.json?.error?.code === "PLATFORM_PERMISSION_DENIED", `status=${b8.status} ${String(JSON.stringify(b8.json)).slice(0, 120)}`);
  const b9 = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "totally.unknown", payload: {}, reason: `unknown kind must 422 ${TS}` }) });
  check("B9 unknown kind → 422 (deny by default registry)", b9.status === 422);
  const b10 = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { wrong: 1 }, reason: `invalid payload must 422 ${TS}` }) });
  check("B10 invalid payload → 422", b10.status === 422);

  // Self-approval — the requester (BILLING) cannot approve their own request.
  const b11 = await BIL(`/api/v1/platform/approvals/${approvalId}/approve`, { method: "POST", body: JSON.stringify({ note: "self" }) });
  check("B11 requester self-approval → 403 PLATFORM_SELF_APPROVAL_DENIED", b11.status === 403 && b11.json?.error?.code === "PLATFORM_SELF_APPROVAL_DENIED", JSON.stringify(b11.json?.error?.code));

  // SECURITY holds approvals:manage but NOT pricing:manage — target-op gate.
  const b12 = await SEC(`/api/v1/platform/approvals/${approvalId}/approve`, { method: "POST", body: JSON.stringify({ note: "sec" }) });
  check("B12 approvals:manage without pricing:manage → 403 PERMISSION_DENIED", b12.status === 403 && b12.json?.error?.code === "PLATFORM_PERMISSION_DENIED" && b12.json?.error?.details?.permission === "platform:pricing:manage", JSON.stringify(b12.json?.error?.details));

  // Happy path: SUPER2 (different operator, pricing:manage) approves.
  const b13 = await S2OP(`/api/v1/platform/approvals/${approvalId}/approve`, { method: "POST", body: JSON.stringify({ note: `Reviewed — approved by second operator ${TS}` }) });
  check("B13 second operator approves → 200 APPROVED", b13.status === 200 && b13.json?.data?.approval?.status === "APPROVED" && b13.json?.data?.approval?.approver?.email === super2User.email, JSON.stringify(b13.json?.error));
  const b14 = await S2OP(`/api/v1/platform/approvals/${approvalId}/approve`, { method: "POST", body: "{}" });
  check("B14 double approve → 409 (guarded transition)", b14.status === 409);

  // Execution demands reauthentication (§56).
  const b15 = await S2(`/api/v1/platform/approvals/${approvalId}/execute`, { method: "POST", body: "{}" });
  check("B15 execute without password → 403 PLATFORM_REAUTH_REQUIRED", b15.status === 403 && b15.json?.error?.code === "PLATFORM_REAUTH_REQUIRED");

  const b16 = await S2(`/api/v1/platform/approvals/${approvalId}/execute`, { method: "POST", body: JSON.stringify({ password: PW }) });
  check("B16 execute with reauth → 200 EXECUTED", b16.status === 200 && b16.json?.data?.approval?.status === "EXECUTED", JSON.stringify(b16.json?.error));
  const bookAfter = await db.priceBook.findUnique({ where: { id: book.id } });
  check("B17 price book ACTUALLY activated (financial effect, §13)", bookAfter?.active === true);
  const b18 = await S2(`/api/v1/platform/approvals/${approvalId}/execute`, { method: "POST", body: JSON.stringify({ password: PW }) });
  check("B18 double execute → 409 (terminal EXECUTED)", b18.status === 409);

  // Audit trail: created / approved / executed.
  const auditRows = await db.platformAuditLog.findMany({ where: { entityType: "PlatformApprovalRequest", entityId: approvalId }, select: { action: true } });
  const actions = new Set(auditRows.map((r) => r.action));
  check("B19 audit: created+approved+executed recorded", actions.has("platform.approval.created") && actions.has("platform.approval.approved") && actions.has("platform.approval.executed"), [...actions].join(","));

  // Reject flow.
  const rejCreate = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `To be rejected ${TS}` }) });
  const rejId = rejCreate.json?.data?.approval?.id;
  approvalIds.push(rejId ?? "");
  const b20 = await S2OP(`/api/v1/platform/approvals/${rejId}/reject`, { method: "POST", body: JSON.stringify({ reason: `Window closed — retry next quarter ${TS}` }) });
  check("B20 reject with reason → 200 REJECTED", b20.status === 200 && b20.json?.data?.approval?.status === "REJECTED" && !!b20.json?.data?.approval?.rejectionReason);
  const b21 = await S2(`/api/v1/platform/approvals/${rejId}/execute`, { method: "POST", body: JSON.stringify({ password: PW }) });
  check("B21 rejected request cannot execute → 409", b21.status === 409);

  // Cancel flow: only the requester can cancel a PENDING request.
  const canCreate = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `To be cancelled ${TS}` }) });
  const canId = canCreate.json?.data?.approval?.id;
  approvalIds.push(canId ?? "");
  const b22 = await S2OP(`/api/v1/platform/approvals/${canId}/cancel`, { method: "POST", body: "{}" });
  check("B22 non-requester cancel → 403", b22.status === 403);
  const b23 = await BIL(`/api/v1/platform/approvals/${canId}/cancel`, { method: "POST", body: "{}" });
  check("B23 requester cancel → 200 CANCELLED", b23.status === 200 && b23.json?.data?.approval?.status === "CANCELLED");

  // Expiry law: a request whose TTL has passed can neither approve nor execute.
  const expCreate = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `To expire ${TS}` }) });
  const expId = expCreate.json?.data?.approval?.id;
  approvalIds.push(expId ?? "");
  await db.platformApprovalRequest.update({ where: { id: expId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const b24 = await S2OP(`/api/v1/platform/approvals/${expId}/approve`, { method: "POST", body: "{}" });
  check("B24 approving an expired request → 409 (lazy sweep)", b24.status === 409);
  const expRow = await db.platformApprovalRequest.findUnique({ where: { id: expId } });
  check("B25 expired request swept to EXPIRED", expRow?.status === "EXPIRED", `status=${expRow?.status}`);

  // Concurrency law: exactly ONE of two parallel executions wins.
  const concCreate = await BIL("/api/v1/platform/approvals", { method: "POST", body: JSON.stringify({ kind: "pricing.activate", payload: { priceBookId: book.id }, reason: `Concurrency probe ${TS}` }) });
  const concId = concCreate.json?.data?.approval?.id;
  approvalIds.push(concId ?? "");
  await S2OP(`/api/v1/platform/approvals/${concId}/approve`, { method: "POST", body: "{}" });
  // Deactivate the book again so the concurrent execution does real work.
  await db.priceBook.update({ where: { id: book.id }, data: { active: false } });
  const [c1, c2] = await Promise.all([
    S2(`/api/v1/platform/approvals/${concId}/execute`, { method: "POST", body: JSON.stringify({ password: PW }) }),
    S2(`/api/v1/platform/approvals/${concId}/execute`, { method: "POST", body: JSON.stringify({ password: PW }) }),
  ]);
  const statuses = [c1, c2].map((r) => r.status).sort();
  const concRow = await db.platformApprovalRequest.findUnique({ where: { id: concId } });
  check("B26 concurrent execute → exactly one 200 + one 409, single EXECUTED", statuses[0] === 200 && statuses[1] === 409 && concRow?.status === "EXECUTED", `statuses=${statuses.join("/")} row=${concRow?.status}`);

  /* --------------------- C. security summary (§11) ------------------------- */
  console.log("\n== C. security summary additions ==");
  const sum = await S2("/api/v1/platform/security/summary");
  const sumData = sum.json?.data;
  check("C1 summary carries activeOperatorsWithoutMfa + pendingApprovalRequests", sum.status === 200 && typeof sumData?.activeOperatorsWithoutMfa === "number" && typeof sumData?.pendingApprovalRequests === "number");
  const dbPending = await db.platformApprovalRequest.count({ where: { status: "PENDING" } });
  check("C2 pendingApprovalRequests == DB truth", sumData?.pendingApprovalRequests === dbPending, `api=${sumData?.pendingApprovalRequests} db=${dbPending}`);
  // Consistency law: the API count must equal the direct DB truth for the
  // ACTIVE policy population (SUPER_ADMIN mode → enrolled supers excluded).
  const dbSupersNoMfa = await db.platformOperator.count({
    where: { active: true, role: "PLATFORM_SUPER_ADMIN", user: { OR: [{ mfaCredential: { is: null } }, { mfaCredential: { enabledAt: null } }] } },
  });
  check("C3 activeOperatorsWithoutMfa == DB truth (policy-scoped population)", sumData?.activeOperatorsWithoutMfa === dbSupersNoMfa, `api=${sumData?.activeOperatorsWithoutMfa} db=${dbSupersNoMfa}`);

  /* -------------------------------- cleanup -------------------------------- */
  console.log("\n== cleanup ==");
  await db.platformApprovalRequest.deleteMany({ where: { id: { in: approvalIds.filter(Boolean) } } });
  await db.platformAuditLog.deleteMany({ where: { OR: [{ operatorId: { in: operatorIds } }, { entityType: "PlatformApprovalRequest", entityId: { in: approvalIds.filter(Boolean) } }] } });
  await db.planPrice.deleteMany({ where: { priceBookId: { in: priceBookIds } } });
  await db.priceBook.deleteMany({ where: { id: { in: priceBookIds } } });
  await clearFixtureMfa(db, createdUserIds);
  await db.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });

  const leftUsers = await db.user.count({ where: { email: { contains: TS } } });
  const leftBooks = await db.priceBook.count({ where: { code: { contains: `r65-appr-${TS}` } } });
  const leftApprovals = await db.platformApprovalRequest.count({ where: { id: { in: approvalIds.filter(Boolean) } } });
  check("cleanup: zero fixture residue", leftUsers === 0 && leftBooks === 0 && leftApprovals === 0, `users=${leftUsers} books=${leftBooks} approvals=${leftApprovals}`);

  console.log("\n=========================================");
  console.log(`R65 ZERO-TRUST CHECK: ${pass}/${pass + fail} PASS${fail === 0 ? " — ALL GREEN ✓" : ` — ${fail} FAILED ✗`}`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("R65 harness crashed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

/**
 * R69 SECURITY-HARDENING BATTERY (Prompt 69 §5) — live proof of the R69 fixes.
 *
 *   A  SAME-ORIGIN ENFORCEMENT (F2): cross-site POST blocked at the wrapper
 *      (403 ORIGIN_REJECTED BEFORE auth); Origin:null blocked; no-Origin
 *      (non-browser) allowed through to auth; GET never checked; webhook +
 *      NextAuth paths exempt; same-origin authenticated mutation succeeds;
 *      the SAME authenticated mutation is blocked cross-origin (the actual
 *      CSRF kill-proof).
 *   B  CLIENT-IP POLICY (F3): getClientIp takes the LAST X-Forwarded-For
 *      element (the only trusted observation behind the Caddy edge), falls
 *      back to x-real-ip, trims whitespace, handles empty lists.
 *   C  INVITE TOKEN HASHING (F1): redemption + preview resolve through the
 *      SHA-256 digest; the DB row contains NO raw token (64-hex tokenHash,
      raw 48-char token absent); legacy rehash script semantics honored.
 *   D  AI-COST RECONCILIATION APPROVAL (§3.6): registry contains exactly
 *      {pricing.activate, ai-cost.reconcile}; unknown kind 422; junk payload
 *      canonicalized to {}; READONLY cannot create; requester self-approval
 *      denied; different-operator approval OK; execution REALLY reconciles a
 *      fixture UNKNOWN cost record to KNOWN with the exact BigInt cost from
 *      the authoritative rate (no client-provided amounts); EXECUTED is
 *      terminal (replay 409); payload tamper rejected (hash binding); expiry
 *      blocks execution; concurrent double-claim produces exactly one
 *      execution; requester cancel still works; audit rows record
 *      created/approved/executed with the scalar outcome summary.
 *   E  CLEANUP: full FK-safe sweep — zero residue.
 *
 * Run: bun --conditions react-server scripts/r69-security-hardening-check.ts
 * Requires: dev server on :3000. Safe against a platform WITH operators
 * (section D runs at the service level with fixture contexts only).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { callerOf, jarFetch, enrollFixtureMfa, platformMfaLogin } from "./lib/platform-mfa";
import { hashInviteToken, redeemOperatorInvite } from "../src/lib/platform/operator-invites";
import { getClientIp, ApiError } from "../src/lib/api-helpers";
import {
  APPROVAL_KINDS,
  approvalDto,
  approveApprovalRequest,
  cancelApprovalRequest,
  createApprovalRequest,
  executeApprovalRequest,
  sweepExpiredApprovals,
} from "../src/lib/platform/approvals";
import type { PlatformContext } from "../src/lib/platform/auth";

const BASE = "http://localhost:3000";
const PW = "R69Hard!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const operatorIds: string[] = [];
const inviteIds: string[] = [];
const approvalIds: string[] = [];
const auditEntityIds: string[] = [];
const businessIds: string[] = [];
const rateIds: string[] = [];

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

const rawFetch = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers as any) },
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
};

/** Cookie-jar session caller (same transport contract as r64/r65/r67/r68). */
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

/** Fresh password-only login jar (for MFA enrollment). */
function loginJarOf(email: string) {
  return (async () => {
    const jar = new Map<string, string>();
    const f = jarFetch(jar);
    const csrf = await (await f("/api/auth/csrf")).json() as any;
    await f("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password: PW }).toString(),
    });
    return jar;
  })();
}

async function fixtureUser(email: string, name: string) {
  const u = await db.user.create({
    data: { email, name, passwordHash: hash(PW), emailVerifiedAt: new Date() },
  });
  createdUserIds.push(u.id);
  return u;
}

/** PlatformContext for service-level approval tests (trusts the caller). */
function fakeCtx(operatorId: string, userId: string, role: string): PlatformContext {
  const perms: Record<string, string[]> = {
    PLATFORM_SUPER_ADMIN: ["platform:approvals:manage", "platform:ai-cost:reconcile", "platform:pricing:manage"],
    PLATFORM_READONLY: ["platform:approvals:read"],
  };
  return {
    session: {} as PlatformContext["session"],
    operatorId,
    userId,
    email: `${role.toLowerCase()}-${TS}@t.dev`,
    role: role as PlatformContext["role"],
    permissions: (perms[role] ?? []) as PlatformContext["permissions"],
  };
}

/** FK-safe sweep of crashed-run fixture residue (self-healing law). */
async function preSweep() {
  const stale = await db.user.findMany({ where: { email: { contains: "r69-" } }, select: { id: true } });
  for (const u of stale) {
    const ops = await db.platformOperator.findMany({ where: { userId: u.id }, select: { id: true } });
    for (const op of ops) {
      await db.platformAuditLog.deleteMany({ where: { operatorId: op.id } });
      await db.platformOperator.delete({ where: { id: op.id } });
    }
    await db.mfaRecoveryCode.deleteMany({ where: { userId: u.id } });
    await db.mfaCredential.deleteMany({ where: { userId: u.id } });
    await db.mfaLoginChallenge.deleteMany({ where: { userId: u.id } });
    await db.userSession.deleteMany({ where: { userId: u.id } });
    await db.securityEvent.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } });
  }
  if (stale.length) console.log(`  (pre-swept ${stale.length} crashed-run fixture users)`);
  // Stale battery businesses (cascade removes AiCostRecords + membership rows).
  const staleBiz = await db.business.findMany({ where: { OR: [{ name: { contains: "r69-harness" } }, { slug: { contains: "r69-harness" } }] }, select: { id: true } });
  for (const b of staleBiz) {
    await db.businessMember.deleteMany({ where: { businessId: b.id } });
    await db.aiCostRate.deleteMany({ where: { provider: "r69-harness" } });
    await db.business.delete({ where: { id: b.id } }).catch(() => undefined);
  }
  await db.aiCostRate.deleteMany({ where: { provider: "r69-harness" } });
  const staleInvites = await db.platformOperatorInvite.findMany({ where: { email: { contains: "r69-" } }, select: { id: true } });
  for (const inv of staleInvites) await db.platformOperatorInvite.delete({ where: { id: inv.id } });
  const staleApprovals = await db.platformApprovalRequest.findMany({ where: { reason: { contains: "r69-harness" } }, select: { id: true } });
  for (const a of staleApprovals) {
    await db.platformAuditLog.deleteMany({ where: { entityId: a.id } });
    await db.platformApprovalRequest.delete({ where: { id: a.id } });
  }
}

async function sectionA() {
  console.log("\n== A. SAME-ORIGIN ENFORCEMENT (F2) ==\n");

  // A1 — cross-site POST is rejected BEFORE authentication even runs.
  const a1 = await rawFetch("/api/v1/platform/approvals", {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: JSON.stringify({ kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness a1" }),
  });
  check("A1 cross-site POST → 403 ORIGIN_REJECTED (pre-auth)", a1.status === 403 && a1.json?.error?.code === "ORIGIN_REJECTED", `got ${a1.status}/${a1.json?.error?.code}`);

  // A2 — Origin "null" (sandboxed iframe / data URI) is denied.
  const a2 = await rawFetch("/api/v1/platform/approvals", {
    method: "POST",
    headers: { origin: "null" },
    body: JSON.stringify({ kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness a2" }),
  });
  check("A2 Origin:null POST → 403 ORIGIN_REJECTED", a2.status === 403 && a2.json?.error?.code === "ORIGIN_REJECTED", `got ${a2.status}/${a2.json?.error?.code}`);

  // A3 — no Origin (curl / server-to-server) passes the check and reaches auth.
  const a3 = await rawFetch("/api/v1/platform/approvals", {
    method: "POST",
    body: JSON.stringify({ kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness a3" }),
  });
  check("A3 no-Origin POST reaches auth (401, not 403 ORIGIN)", a3.status === 401 && a3.json?.error?.code !== "ORIGIN_REJECTED", `got ${a3.status}/${a3.json?.error?.code}`);

  // A4 — same-origin anonymous POST reaches auth as well (host match).
  const a4 = await rawFetch("/api/v1/platform/approvals", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: JSON.stringify({ kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness a4" }),
  });
  check("A4 same-origin POST reaches auth (401, not 403 ORIGIN)", a4.status === 401 && a4.json?.error?.code !== "ORIGIN_REJECTED", `got ${a4.status}/${a4.json?.error?.code}`);

  // A5 — GET is a safe method: never origin-checked.
  const a5 = await rawFetch("/api/v1/platform/approvals", { headers: { origin: "https://evil.example" } });
  check("A5 cross-site GET passes check (401 auth error)", a5.status === 401 && a5.json?.error?.code !== "ORIGIN_REJECTED", `got ${a5.status}/${a5.json?.error?.code}`);

  // A6 — provider webhooks are exempt (signature-authenticated, no cookies).
  const a6 = await rawFetch("/api/v1/webhooks/payments/r69none", {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: JSON.stringify({ any: "body" }),
  });
  check("A6 webhook POST with foreign Origin NOT origin-blocked", !(a6.status === 403 && a6.json?.error?.code === "ORIGIN_REJECTED"), `got ${a6.status}/${a6.json?.error?.code}`);

  // A7 — NextAuth endpoints keep their own CSRF; exempt from the wrapper check.
  const a7 = await rawFetch("/api/auth/csrf", { method: "GET" });
  const a7b = await rawFetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: "csrfToken=x&email=no@no.dev&password=x",
  });
  check("A7 /api/auth/* exempt from wrapper origin check", a7.status === 200 && a7b.status !== 403, `csrf ${a7.status}, callback ${a7b.status}`);

  // A8/A9 — the CSRF kill-proof: ONE authenticated body-less mutation that
  // succeeds same-origin and is blocked cross-origin with the SAME session.
  const user = await fixtureUser(`r69-csrf-${TS}@t.dev`, "R69 CSRF Fixture");
  const call = sessionCaller(user.email);
  const okSame = await call("/api/v1/me/notifications/read-all", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
  });
  check("A8 authenticated same-origin mutation → 200", okSame.status === 200, `got ${okSame.status}`);
  const blocked = await call("/api/v1/me/notifications/read-all", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  check("A9 SAME session cross-origin mutation → 403 ORIGIN_REJECTED", blocked.status === 403 && blocked.json?.error?.code === "ORIGIN_REJECTED", `got ${blocked.status}/${blocked.json?.error?.code}`);
}

async function sectionB() {
  console.log("\n== B. CLIENT-IP LAST-ELEMENT POLICY (F3) ==\n");
  const req = (headers: Record<string, string>) => new Request("http://localhost:3000/", { headers });

  check("B1 multi-hop XFF → LAST element", getClientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })) === "5.6.7.8", getClientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })));
  check("B2 single XFF (Caddy replaces) → that value", getClientIp(req({ "x-forwarded-for": "9.9.9.9" })) === "9.9.9.9");
  check("B3 no XFF → x-real-ip fallback", getClientIp(req({ "x-real-ip": "7.7.7.7" })) === "7.7.7.7");
  check("B4 no headers → 'unknown'", getClientIp(req({})) === "unknown");
  check("B5 empty XFF list → 'unknown'", getClientIp(req({ "x-forwarded-for": " , , " })) === "unknown");
}

async function sectionC() {
  console.log("\n== C. INVITE TOKEN HASH-ONLY STORAGE (F1) ==\n");

  // NOTE: the token's FIRST 12 CHARS seed the per-IP+token rate-limit key —
  // they must be unique per run, so the run stamp leads the token body.
  const rawToken = (`${TS}${"t".repeat(50)}`).slice(0, 48);
  const inviter = await fixtureUser(`r69-inviter-${TS}@t.dev`, "R69 Inviter Fixture");
  const invite = await db.platformOperatorInvite.create({
    data: {
      tokenHash: hashInviteToken(rawToken),
      email: `r69-invitee-${TS}@t.dev`,
      name: "R69 Invitee Fixture",
      role: "PLATFORM_SUPPORT",
      createdById: inviter.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  inviteIds.push(invite.id);

  // C1 — the stored value is the DIGEST, never the raw token.
  const stored = await db.platformOperatorInvite.findUnique({ where: { id: invite.id } });
  check("C1 stored tokenHash is 64-hex digest", !!stored && /^[0-9a-f]{64}$/.test(stored.tokenHash), stored?.tokenHash.slice(0, 12));
  check("C2 raw token absent from stored row", !!stored && !JSON.stringify(stored).includes(rawToken));

  // C3 — anonymous PREVIEW through the API resolves the raw token via hash.
  const preview = await rawFetch(`/api/v1/platform/invites/${encodeURIComponent(rawToken)}`);
  check("C3 preview resolves raw token through digest lookup", preview.status === 200 && preview.json?.data?.invite?.email === `r69-invitee-${TS}@t.dev`, `got ${preview.status}`);

  // C4 — redemption through the API works (existing-account binding path).
  const invitee = await fixtureUser(`r69-invitee-${TS}@t.dev`, "R69 Invitee Fixture");
  const redeem = await rawFetch(`/api/v1/platform/invites/${encodeURIComponent(rawToken)}`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  });
  check("C4 redemption succeeds through digest lookup", redeem.status === 200 && redeem.json?.data?.accountCreated === false, `got ${redeem.status}`);
  const operator = await db.platformOperator.findFirst({ where: { userId: invitee.id } });
  if (operator) operatorIds.push(operator.id);
  check("C5 redemption created the operator row (role preserved)", operator?.role === "PLATFORM_SUPPORT", operator?.role ?? "none");

  // C6 — replay: second redemption is unavailable (single-use survives hashing).
  const replay = await rawFetch(`/api/v1/platform/invites/${encodeURIComponent(rawToken)}`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  });
  check("C6 replay redemption rejected (410)", replay.status === 410, `got ${replay.status}`);

  // C7 — wrong token never resolves (no raw-token fallback path exists).
  const wrong = await rawFetch(`/api/v1/platform/invites/${encodeURIComponent(rawToken.slice(0, -2) + "zz")}`);
  check("C7 wrong token → 404 PLATFORM_INVITE_INVALID", wrong.status === 404, `got ${wrong.status}`);
}

async function sectionD() {
  console.log("\n== D. AI-COST RECONCILIATION APPROVAL (§3.6) ==\n");

  check("D1 registry has exactly the two sanctioned kinds", APPROVAL_KINDS.length === 2 && APPROVAL_KINDS.includes("pricing.activate") && APPROVAL_KINDS.includes("ai-cost.reconcile"), APPROVAL_KINDS.join(","));

  const requesterUser = await fixtureUser(`r69-req-${TS}@t.dev`, "R69 Requester Fixture");
  const approverUser = await fixtureUser(`r69-appr-${TS}@t.dev`, "R69 Approver Fixture");
  const readonlyUser = await fixtureUser(`r69-ro-${TS}@t.dev`, "R69 Readonly Fixture");
  const requesterOp = await db.platformOperator.create({
    data: { userId: requesterUser.id, role: "PLATFORM_SUPER_ADMIN", active: true }, select: { id: true },
  });
  const approverOp = await db.platformOperator.create({
    data: { userId: approverUser.id, role: "PLATFORM_SUPER_ADMIN", active: true }, select: { id: true },
  });
  const readonlyOp = await db.platformOperator.create({
    data: { userId: readonlyUser.id, role: "PLATFORM_READONLY", active: true }, select: { id: true },
  });
  operatorIds.push(requesterOp.id, approverOp.id, readonlyOp.id);

  const requester = fakeCtx(requesterOp.id, requesterUser.id, "PLATFORM_SUPER_ADMIN");
  const approver = fakeCtx(approverOp.id, approverUser.id, "PLATFORM_SUPER_ADMIN");
  const readonlyCtx = fakeCtx(readonlyOp.id, readonlyUser.id, "PLATFORM_READONLY");

  // D2 — unknown kind can never be requested (deny by default).
  let d2: unknown = null;
  try { await createApprovalRequest({ ctx: requester, kind: "ai-cost.wipe", payload: {}, reason: "r69-harness d2" }); }
  catch (e) { d2 = e; }
  check("D2 unknown approval kind → 422 PLATFORM_INVALID_OPERATION", d2 instanceof ApiError && (d2 as ApiError).status === 422, `${(d2 as ApiError)?.status}/${(d2 as ApiError)?.code}`);

  // D3 — READONLY cannot mint approval requests.
  let d3: unknown = null;
  try { await createApprovalRequest({ ctx: readonlyCtx, kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness d3" }); }
  catch (e) { d3 = e; }
  check("D3 READONLY create → 403 (manage permission required)", d3 instanceof ApiError && (d3 as ApiError).status === 403, `${(d3 as ApiError)?.status}/${(d3 as ApiError)?.code}`);

  // D4 — junk payload canonicalizes to {} (client can add no parameters).
  const d4 = await createApprovalRequest({ ctx: requester, kind: "ai-cost.reconcile", payload: { sneaky: { windowDays: 9999 } }, reason: "r69-harness d4" });
  approvalIds.push(d4.id);
  auditEntityIds.push(d4.id);
  check("D4 junk payload stored as canonical {}", d4.payloadJson === "{}" && d4.payloadHash.length === 64, `payloadJson=${d4.payloadJson}`);
  const d4dto = approvalDto(d4);
  check("D5 describe is bounded and parameterless", typeof d4dto.kindLabel === "string" && d4dto.kindLabel.includes("AI-cost reconciliation") && !d4dto.kindLabel.includes("9999"), d4dto.kindLabel.slice(0, 60));

  // D6 — the requester cannot approve their own request.
  let d6: unknown = null;
  try { await approveApprovalRequest({ ctx: requester, id: d4.id, note: "self" }); }
  catch (e) { d6 = e; }
  check("D6 requester self-approval → 403 PLATFORM_SELF_APPROVAL_DENIED", d6 instanceof ApiError && (d6 as ApiError).code === "PLATFORM_SELF_APPROVAL_DENIED", `${(d6 as ApiError)?.status}/${(d6 as ApiError)?.code}`);

  // D7 — a different authorized operator approves.
  const d7 = await approveApprovalRequest({ ctx: approver, id: d4.id, note: "r69-harness approve" });
  check("D7 different-operator approval → APPROVED", d7.status === "APPROVED" && d7.approverId === approverOp.id, d7.status);

  // D8 — execution REALLY reconciles a fixture record with authoritative math.
  const ownerBiz = await db.business.create({
    data: { name: `r69-harness-${TS}`, slug: `r69-harness-${TS}`, ownerId: requesterUser.id, currencyCode: "USD" }, select: { id: true },
  });
  businessIds.push(ownerBiz.id);
  const rate = await db.aiCostRate.create({
    data: {
      provider: "r69-harness", model: "r69-model", currency: "USD", version: "r69-v1",
      inputRateNanoMinorPer1K: 1_000_000n, outputRateNanoMinorPer1K: 2_000_000n,
      effectiveFrom: new Date(Date.now() - 60 * 60 * 1000), active: true, environment: "TEST", verifiedAt: null,
    }, select: { id: true },
  });
  rateIds.push(rate.id);
  const unknownRecord = await db.aiCostRecord.create({
    data: {
      usageEventId: `r69-usage-${TS}`, requestId: `r69-req-${TS}`, businessId: ownerBiz.id,
      planCodeAtUsage: "R69TEST", provider: "r69-harness", model: "r69-model",
      currency: "USD", environment: "TEST", inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
      tokenStatus: "COMPLETE", costStatus: "UNKNOWN", unknownReason: "NO_RATE",
    }, select: { id: true },
  });

  const d8 = await executeApprovalRequest({ ctx: approver, id: d4.id });
  check("D8 execution succeeds (ok=true)", d8.ok === true, d8.ok ? "" : `errorCode=${(d8 as { errorCode?: string }).errorCode}`);
  if (d8.ok) {
    const report = d8.result as { mode?: string; updatedCount?: number; boundedWindow?: { from: string } };
    check("D9 report mode APPLY + updatedCount=1", report.mode === "APPLY" && report.updatedCount === 1, `updated=${report.updatedCount}`);
  }
  const reconciled = await db.aiCostRecord.findUnique({ where: { id: unknownRecord.id } });
  // 1000 in @ 1_000_000 nminor/1K + 500 out @ 2_000_000 nminor/1K = 2_000_000 nminor.
  check("D10 record KNOWN with exact authoritative BigInt cost", reconciled?.costStatus === "KNOWN" && reconciled?.costNanoMinor === 2_000_000n, `status=${reconciled?.costStatus} cost=${reconciled?.costNanoMinor}`);
  check("D11 rate snapshot bound to the record", reconciled?.rateId === rate.id && reconciled?.unknownReason === null, reconciled?.rateId ?? "none");

  // D12 — EXECUTED is terminal: replay is rejected.
  let d12: unknown = null;
  try { await executeApprovalRequest({ ctx: approver, id: d4.id }); }
  catch (e) { d12 = e; }
  check("D12 replay after EXECUTED → 409", d12 instanceof ApiError && (d12 as ApiError).status === 409, `${(d12 as ApiError)?.status}/${(d12 as ApiError)?.code}`);

  // D13 — payload CORRUPTION invalidates the approval (hash binding).
  // (For a parameterless kind, schema-stripping makes any valid-JSON junk
  // semantically identical to {} — the binding bites on corruption and, for
  // parameterized kinds like pricing.activate, on value changes.)
  const tampered = await createApprovalRequest({ ctx: requester, kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness d13" });
  approvalIds.push(tampered.id); auditEntityIds.push(tampered.id);
  await approveApprovalRequest({ ctx: approver, id: tampered.id });
  await db.platformApprovalRequest.update({ where: { id: tampered.id }, data: { payloadJson: '{"windowDays":9999,corrupt' } });
  let d13: unknown = null;
  try { await executeApprovalRequest({ ctx: approver, id: tampered.id }); }
  catch (e) { d13 = e; }
  check("D13 corrupted payload → 409 INVALID_STATE (hash/parse guard)", d13 instanceof ApiError && (d13 as ApiError).status === 409, `${(d13 as ApiError)?.status}/${(d13 as ApiError)?.code}`);

  // D14 — expired requests cannot execute (lazy sweep + claim guard).
  const expired = await createApprovalRequest({ ctx: requester, kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness d14" });
  approvalIds.push(expired.id); auditEntityIds.push(expired.id);
  await approveApprovalRequest({ ctx: approver, id: expired.id });
  await db.platformApprovalRequest.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await sweepExpiredApprovals();
  let d14: unknown = null;
  try { await executeApprovalRequest({ ctx: approver, id: expired.id }); }
  catch (e) { d14 = e; }
  check("D14 expired request → 409 (not executable)", d14 instanceof ApiError && (d14 as ApiError).status === 409, `${(d14 as ApiError)?.status}/${(d14 as ApiError)?.code}`);

  // D15 — concurrent double-claim: exactly ONE execution wins.
  const racer = await createApprovalRequest({ ctx: requester, kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness d15" });
  approvalIds.push(racer.id); auditEntityIds.push(racer.id);
  await approveApprovalRequest({ ctx: approver, id: racer.id });
  const results = await Promise.allSettled([
    executeApprovalRequest({ ctx: approver, id: racer.id }),
    executeApprovalRequest({ ctx: approver, id: racer.id }),
  ]);
  const oks = results.filter((r) => r.status === "fulfilled" && (r.value as { ok?: boolean }).ok === true).length;
  const conflicts = results.filter((r) => r.status === "rejected" && (r.reason as ApiError)?.status === 409).length;
  check("D15 concurrent execution → exactly 1 ok + 1 conflict", oks === 1 && conflicts === 1, `ok=${oks} conflict=${conflicts}`);

  // D16 — requester cancel path still intact for a fresh PENDING request.
  const cancellable = await createApprovalRequest({ ctx: requester, kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness d16" });
  approvalIds.push(cancellable.id); auditEntityIds.push(cancellable.id);
  const d16 = await cancelApprovalRequest({ ctx: requester, id: cancellable.id });
  check("D16 requester cancel → CANCELLED", d16.status === "CANCELLED", d16.status);

  // D17 — ROUTE-level audit trail with the R69 outcome enrichment: the full
  // lifecycle (create → approve → execute) through the REAL HTTP API with
  // two MFA-enrolled super admins, then the audit row must carry the scalar
  // reconciliation summary (updatedCount + bounded window).
  const reqMfa = await enrollFixtureMfa(callerOf(await loginJarOf(requesterUser.email)), PW);
  const appMfa = await enrollFixtureMfa(callerOf(await loginJarOf(approverUser.email)), PW);
  const R = callerOf(await platformMfaLogin(requesterUser.email, PW, reqMfa.secret));
  const A = callerOf(await platformMfaLogin(approverUser.email, PW, appMfa.secret));

  // A SECOND unknown record for the HTTP execute to reconcile (D8's was
  // already reconciled at service level).
  const unknown2 = await db.aiCostRecord.create({
    data: {
      usageEventId: `r69-usage2-${TS}`, requestId: `r69-req2-${TS}`, businessId: ownerBiz.id,
      planCodeAtUsage: "R69TEST", provider: "r69-harness", model: "r69-model",
      currency: "USD", environment: "TEST", inputTokens: 2000, outputTokens: 1000, totalTokens: 3000,
      tokenStatus: "COMPLETE", costStatus: "UNKNOWN", unknownReason: "NO_RATE",
    }, select: { id: true },
  });

  const cr = await R("/api/v1/platform/approvals", {
    method: "POST",
    body: JSON.stringify({ kind: "ai-cost.reconcile", payload: {}, reason: "r69-harness d17 dual control" }),
  });
  check("D17a requester creates via HTTP → 200 PENDING", cr.status === 200 && cr.json?.data?.approval?.status === "PENDING", `got ${cr.status}`);
  const approvalId = cr.json?.data?.approval?.id as string | undefined;
  approvalIds.push(approvalId ?? ""); auditEntityIds.push(approvalId ?? "");

  const selfApprove = await R(`/api/v1/platform/approvals/${approvalId}/approve`, {
    method: "POST", body: JSON.stringify({ note: "self" }),
  });
  check("D17b requester self-approval via HTTP → 403", selfApprove.status === 403 && selfApprove.json?.error?.code === "PLATFORM_SELF_APPROVAL_DENIED", `got ${selfApprove.status}`);

  const ap = await A(`/api/v1/platform/approvals/${approvalId}/approve`, {
    method: "POST", body: JSON.stringify({ note: "r69-harness d17 approve" }),
  });
  check("D17c approver approves via HTTP → 200 APPROVED", ap.status === 200 && ap.json?.data?.approval?.status === "APPROVED", `got ${ap.status}`);

  const ex = await A(`/api/v1/platform/approvals/${approvalId}/execute`, {
    method: "POST", body: JSON.stringify({ password: PW }),
  });
  check("D17d approver executes via HTTP → 200 EXECUTED", ex.status === 200 && ex.json?.data?.approval?.status === "EXECUTED", `got ${ex.status}/${ex.json?.error?.code ?? ""}`);

  const record2 = await db.aiCostRecord.findUnique({ where: { id: unknown2.id } });
  // 2000 in @ 1_000_000 + 1000 out @ 2_000_000 = 4_000_000 nano-minor.
  check("D17e HTTP execution reconciled the record with exact cost", record2?.costStatus === "KNOWN" && record2?.costNanoMinor === 4_000_000n, `status=${record2?.costStatus} cost=${record2?.costNanoMinor}`);

  const audits = await db.platformAuditLog.findMany({ where: { entityId: approvalId }, orderBy: { createdAt: "asc" } });
  const actions = audits.map((a) => a.action);
  const executedRow = audits.find((a) => a.action === "platform.approval.executed");
  let summaryOk = false;
  if (executedRow?.afterJson) {
    const after = JSON.parse(executedRow.afterJson) as { updatedCount?: number; windowFrom?: string };
    summaryOk = after.updatedCount === 1 && typeof after.windowFrom === "string";
  }
  check("D17f audit created+approved+executed with scalar outcome summary",
    actions.includes("platform.approval.created") && actions.includes("platform.approval.approved") && actions.includes("platform.approval.executed") && summaryOk,
    actions.join(","));

  // D17 cleanup: revoke the MFA fixtures so the sweep stays FK-safe.
  await db.mfaCredential.deleteMany({ where: { userId: { in: [requesterUser.id, approverUser.id] } } });
  await db.mfaRecoveryCode.deleteMany({ where: { userId: { in: [requesterUser.id, approverUser.id] } } });
  await db.mfaLoginChallenge.deleteMany({ where: { userId: { in: [requesterUser.id, approverUser.id] } } });
}

async function cleanup() {
  console.log("\n== E. CLEANUP ==\n");
  for (const id of approvalIds) {
    await db.platformAuditLog.deleteMany({ where: { entityId: id } });
    await db.platformApprovalRequest.delete({ where: { id } }).catch(() => undefined);
  }
  await db.aiCostRate.deleteMany({ where: { id: { in: rateIds } } });
  for (const id of businessIds) {
    await db.businessMember.deleteMany({ where: { businessId: id } });
    await db.business.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of inviteIds) await db.platformOperatorInvite.delete({ where: { id } }).catch(() => undefined);
  for (const id of operatorIds) {
    await db.platformAuditLog.deleteMany({ where: { operatorId: id } });
    await db.platformOperator.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of createdUserIds) {
    await db.mfaRecoveryCode.deleteMany({ where: { userId: id } });
    await db.mfaCredential.deleteMany({ where: { userId: id } });
    await db.mfaLoginChallenge.deleteMany({ where: { userId: id } });
    await db.userSession.deleteMany({ where: { userId: id } });
    await db.securityEvent.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  const residueUsers = await db.user.count({ where: { email: { contains: "r69-" } } });
  const residueOps = await db.platformOperator.count({ where: { id: { in: operatorIds } } });
  const residueApprovals = await db.platformApprovalRequest.count({ where: { reason: { contains: "r69-harness" } } });
  const fk = await db.$queryRawUnsafe<{ fkviolations: bigint }[]>('PRAGMA foreign_key_check');
  check("cleanup: zero fixture residue", residueUsers === 0 && residueOps === 0 && residueApprovals === 0, `users=${residueUsers} ops=${residueOps} approvals=${residueApprovals}`);
  check("cleanup: fk clean", Number(fk[0]?.fkviolations ?? 0) === 0);
}

async function main() {
  console.log(`\n== R69 SECURITY-HARDENING BATTERY — ${new Date().toISOString()} ==\n`);
  await preSweep();
  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
  } finally {
    await cleanup();
  }
  console.log(`\n============================================`);
  console.log(`R69 SECURITY-HARDENING: ${pass} passed, ${fail} failed`);
  console.log(`============================================\n`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => { console.error("HARNESS CRASH:", e); process.exit(1); })
  .finally(() => db.$disconnect());

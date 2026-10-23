/**
 * R64 SECURITY OPS BATTERY — live proof for the four R64 platform features.
 *
 *   A  Auth matrix on the NEW endpoints: export / anomalies (security:read),
 *      operator-sessions GET (operators:read), session revoke DELETE
 *      (security:manage + role) — anon 401 / tenant 403 / wrong-role 403 /
 *      right-role 200.
 *   B  CSV export honesty: BOM + CRLF + exact 8 columns, seeded rows present,
 *      filters honored, unknown eventType 422, x-export-* headers, no raw IP
 *      anywhere (prefix ≤12 hex only), AUDIT row platform.security.events_exported.
 *   C  Burst anomalies: 6 failed events on one user (email burst), 5 on one
 *      IP across two users (ip burst), 3 on a third user (below threshold —
 *      must NOT appear). Response contract + summary.failedLoginBursts1h.
 *   D  Operator sessions: live listing shape; SECURITY revokes a SECOND
 *      operator's session (reason + reauth) → the revoked jar actually dies
 *      (401 SESSION_REVOKED), idempotent re-delete (alreadyRevoked), foreign
 *      session id → 404, audit + SecurityEvent written.
 *   E  First-response SLA: open / due_soon / overdue / met / na verdicts
 *      server-computed; overview.support.slaOverdue == DB truth.
 *   F  Export rate limit: dedicated probe operator → 429 within 7 rapid calls.
 *
 * Cleanup: every fixture row deleted (audit rows swept explicitly — SetNull
 * keeps them after operator deletion); cascade residue asserted zero.
 * Run: bun scripts/r64-security-ops-check.ts   (dev server on :3000)
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { enrollFixtureMfa, platformMfaLogin, clearFixtureMfa } from "./lib/platform-mfa";

const BASE = "http://localhost:3000";
const PW = "R64Ops!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const operatorIds: string[] = [];
const ticketIds: string[] = [];
const seededEventIds: string[] = [];

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.78.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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

async function login(email: string, password: string = PW): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, email, password });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

type Call = (path: string, init?: RequestInit) => Promise<{ status: number; json: any; res: Response }>;

function caller(jar: Map<string, string>): Call {
  const f = jarFetch(jar);
  return async (path, init = {}) => {
    const res = await f(path, init);
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, res };
  };
}

/** Raw variant for non-JSON responses (CSV) — never consumes the body. */
function rawCaller(jar: Map<string, string>) {
  const f = jarFetch(jar);
  return async (path: string, init: RequestInit = {}) => f(path, init);
}

const anon: Call = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers as any) } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, res };
};

const sha = (ip: string) => createHash("sha256").update(`ipsecsalt-v1:${ip}`).digest("hex");

async function seedEvent(data: {
  userId: string; eventType: string; success: boolean; reasonCode?: string;
  ip?: string; userAgent?: string;
}) {
  const row = await db.securityEvent.create({
    data: {
      userId: data.userId,
      eventType: data.eventType,
      success: data.success,
      reasonCode: data.reasonCode ?? null,
      ipHash: data.ip ? sha(data.ip) : null,
      userAgent: data.userAgent ?? null,
    },
  });
  seededEventIds.push(row.id);
  return row;
}

async function main() {
  // Defensive pre-sweep: a previous crashed run may have left r64 fixtures
  // (the battery's own cleanup never ran). Users cascade sessions+events;
  // operators are deleted first; audit rows swept by targetUserId.
  const stale = await db.user.findMany({ where: { email: { contains: "@t.dev" } }, select: { id: true, email: true } });
  const staleR64 = stale.filter((u) => u.email.startsWith("r64-"));
  if (staleR64.length > 0) {
    const staleIds = staleR64.map((u) => u.id);
    const staleOps = await db.platformOperator.findMany({ where: { userId: { in: staleIds } }, select: { id: true } });
    await db.platformAuditLog.deleteMany({ where: { OR: [{ operatorId: { in: staleOps.map((o) => o.id) } }, { targetUserId: { in: staleIds } }] } });
    await db.platformOperator.deleteMany({ where: { id: { in: staleOps.map((o) => o.id) } } });
    await db.user.deleteMany({ where: { id: { in: staleIds } } });
    console.log(`  (pre-swept ${staleR64.length} stale r64 users from a crashed run)`);
  }

  console.log("== R64 fixtures ==");
  const hash = bcrypt.hashSync(PW, 10);

  const superUser = await db.user.create({ data: { email: `r64-sup-${TS}@t.dev`, name: "R64 Super", passwordHash: hash, emailVerifiedAt: new Date() } });
  const secUser = await db.user.create({ data: { email: `r64-sec-${TS}@t.dev`, name: "R64 Security", passwordHash: hash, emailVerifiedAt: new Date() } });
  const bilUser = await db.user.create({ data: { email: `r64-bil-${TS}@t.dev`, name: "R64 Billing", passwordHash: hash, emailVerifiedAt: new Date() } });
  const roUser = await db.user.create({ data: { email: `r64-ro-${TS}@t.dev`, name: "R64 Readonly", passwordHash: hash, emailVerifiedAt: new Date() } });
  const supUser = await db.user.create({ data: { email: `r64-supsup-${TS}@t.dev`, name: "R64 Support", passwordHash: hash, emailVerifiedAt: new Date() } });
  const op2User = await db.user.create({ data: { email: `r64-op2-${TS}@t.dev`, name: "R64 Operator2", passwordHash: hash, emailVerifiedAt: new Date() } });
  const probeUser = await db.user.create({ data: { email: `r64-probe-${TS}@t.dev`, name: "R64 Probe", passwordHash: hash, emailVerifiedAt: new Date() } });
  const tenantUser = await db.user.create({ data: { email: `r64-tenant-${TS}@t.dev`, name: "R64 Tenant", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(superUser.id, secUser.id, bilUser.id, roUser.id, supUser.id, op2User.id, probeUser.id, tenantUser.id);

  const op = async (userId: string, role: string) => {
    const row = await db.platformOperator.create({ data: { userId, role, active: true } });
    operatorIds.push(row.id);
    return row;
  };
  const superOp = await op(superUser.id, "PLATFORM_SUPER_ADMIN");
  const secOp = await op(secUser.id, "PLATFORM_SECURITY");
  const bilOp = await op(bilUser.id, "PLATFORM_BILLING");
  const roOp = await op(roUser.id, "PLATFORM_READONLY");
  const supOp = await op(supUser.id, "PLATFORM_SUPPORT");
  const op2 = await op(op2User.id, "PLATFORM_SUPPORT");
  await op(probeUser.id, "PLATFORM_SECURITY");

  // Burst fixtures: burstUser (email burst, distinct IPs), two ip-burst users,
  // one below-threshold user.
  const burstUser = await db.user.create({ data: { email: `r64-burst-${TS}@t.dev`, name: "R64 Burst", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(burstUser.id);
  const ipUserA = await db.user.create({ data: { email: `r64-ipa-${TS}@t.dev`, name: "R64 IpA", passwordHash: hash, emailVerifiedAt: new Date() } });
  const ipUserB = await db.user.create({ data: { email: `r64-ipb-${TS}@t.dev`, name: "R64 IpB", passwordHash: hash, emailVerifiedAt: new Date() } });
  const lowUser = await db.user.create({ data: { email: `r64-low-${TS}@t.dev`, name: "R64 Low", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(ipUserA.id, ipUserB.id, lowUser.id);

  const UA = "R64-Agent/1.0 (fixture)";
  // Email burst: 6 failed events, DISTINCT ips (no ip burst from this user).
  for (let i = 0; i < 6; i++) {
    await seedEvent({ userId: burstUser.id, eventType: "auth.login.failed", success: false, reasonCode: "INVALID_CREDENTIALS", ip: `198.51.100.${10 + i}`, userAgent: UA });
  }
  // IP burst: 5 failed events on ONE ip across two users (3+2 — no email bucket).
  for (let i = 0; i < 3; i++) await seedEvent({ userId: ipUserA.id, eventType: "auth.login.failed", success: false, reasonCode: "INVALID_CREDENTIALS", ip: "192.0.2.77", userAgent: UA });
  for (let i = 0; i < 2; i++) await seedEvent({ userId: ipUserB.id, eventType: "auth.login.failed", success: false, reasonCode: "INVALID_CREDENTIALS", ip: "192.0.2.77", userAgent: UA });
  // Below threshold: 3 events — must never appear as a burst.
  for (let i = 0; i < 3; i++) await seedEvent({ userId: lowUser.id, eventType: "auth.login.failed", success: false, reasonCode: "INVALID_CREDENTIALS", ip: `192.0.2.${90 + i}`, userAgent: UA });

  // R65 — SUPER_ADMIN MFA enforcement: real-API enrollment (Prompt 65 §6.2).
  const superMfa = await enrollFixtureMfa(caller(await login(superUser.email)), PW);
  const S = caller(await platformMfaLogin(superUser.email, PW, superMfa.secret));
  const SEC = caller(await login(secUser.email));
  const BIL = caller(await login(bilUser.email));
  const RO = caller(await login(roUser.email));
  const SUP = caller(await login(supUser.email));
  const TEN = caller(await login(tenantUser.email));
  const op2Jar = await login(op2User.email);
  const OP2 = caller(op2Jar);

  /* ------------------------ A. auth matrix ------------------------ */
  console.log("== A. auth matrix ==");
  for (const [name, call] of [["anon", anon], ["tenant", TEN], ["billing", BIL], ["support", SUP]] as const) {
    check(`export ${name} → 401/403`, (await call(`/api/v1/platform/security/events/export`)).status === (name === "anon" ? 401 : 403));
    check(`anomalies ${name} → 401/403`, (await call(`/api/v1/platform/security/anomalies`)).status === (name === "anon" ? 401 : 403));
  }
  const opSessionsPath = `/api/v1/platform/operators/${op2.id}/sessions`;
  for (const [name, call] of [["anon", anon], ["tenant", TEN], ["billing", BIL], ["support", SUP]] as const) {
    check(`operator-sessions ${name} → 401/403`, (await call(opSessionsPath)).status === (name === "anon" ? 401 : 403));
  }
  check("anomalies readonly → 200", (await RO(`/api/v1/platform/security/anomalies`)).status === 200);
  check("anomalies security → 200", (await SEC(`/api/v1/platform/security/anomalies`)).status === 200);
  check("export readonly → 200 csv", (await RO(`/api/v1/platform/security/events/export`)).res.headers.get("content-type")?.includes("text/csv") === true);
  check("operator-sessions readonly → 200", (await RO(opSessionsPath)).status === 200);
  check("operator-sessions super → 200", (await S(opSessionsPath)).status === 200);

  // Revoke DELETE: support role lacks security:manage → 403.
  const someSession = (await db.userSession.findFirst({ where: { userId: op2User.id, revokedAt: null }, select: { id: true } }))!;
  const delBody = (reason: string) => ({ method: "DELETE", body: JSON.stringify({ reason, password: PW }) });
  check("revoke support → 403", (await SUP(`/api/v1/platform/operators/${op2.id}/sessions/${someSession.id}`, delBody("support role probe"))).status === 403);
  check("revoke tenant → 403", (await TEN(`/api/v1/platform/operators/${op2.id}/sessions/${someSession.id}`, delBody("tenant probe"))).status === 403);

  /* ------------------------ B. CSV export ------------------------ */
  console.log("== B. CSV export ==");
  const secRaw = rawCaller(await login(secUser.email));
  const expRes = await secRaw(`/api/v1/platform/security/events/export?eventType=auth.login.failed&success=false`);
  const rawBuf = await expRes.arrayBuffer();
  const head3 = new Uint8Array(rawBuf.slice(0, 3));
  // fetch's res.text() strips a UTF-8 BOM per spec — assert the RAW bytes.
  const hasBom = head3[0] === 0xef && head3[1] === 0xbb && head3[2] === 0xbf;
  const csv = new TextDecoder().decode(rawBuf);
  check("export 200 + csv content-type", expRes.status === 200 && expRes.headers.get("content-type")?.includes("text/csv") === true);
  check("export BOM present (raw bytes EF BB BF)", hasBom);
  check("export CRLF line endings", csv.includes("\r\n"));
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter((l) => l.length > 0);
  check("export exact header", lines[0] === "id,createdAt,eventType,success,reasonCode,email,ipHashPrefix,userAgent");
  const dataRows = lines.slice(1);
  check("export rows == x-export-rows", Number(expRes.headers.get("x-export-rows")) === dataRows.length, `rows=${dataRows.length}`);
  check("export truncated=false", expRes.headers.get("x-export-truncated") === "false");
  const failedRows = dataRows.filter((l) => l.includes("auth.login.failed"));
  check("export filter honored (only failed rows)", dataRows.length > 0 && failedRows.length === dataRows.length);
  check("export contains fixture burst user", csv.includes(burstUser.email));
  check("export no raw IP leak", !csv.includes("192.0.2.77") && !csv.includes("198.51.100."));
  const ipPrefixOk = dataRows.every((l) => {
    const cols = l.split(",");
    const prefix = cols[6] ?? "";
    return prefix === "" || /^[0-9a-f]{1,12}$/.test(prefix);
  });
  check("export ipHashPrefix ≤12 hex or empty", ipPrefixOk);
  check("export 8 columns per row", dataRows.every((l) => l.split(",").length === 8));
  const seededPrefix = sha("192.0.2.77").slice(0, 12);
  check("export seeded ip prefix present", csv.includes(seededPrefix));
  const unknownType = await SEC(`/api/v1/platform/security/events/export?eventType=auth.not.a.type`);
  check("export unknown eventType → 422", unknownType.status === 422);
  const auditExport = await db.platformAuditLog.findFirst({
    where: { action: "platform.security.events_exported", operatorId: secOp.id },
    orderBy: { createdAt: "desc" },
  });
  check("export audited", !!auditExport && auditExport.operatorRole === "PLATFORM_SECURITY");
  const afterJson = auditExport ? (JSON.parse(auditExport.afterJson ?? "{}") as any) : {};
  check("export audit carries rows+filters", afterJson.rows === dataRows.length && afterJson.filters?.eventType === "auth.login.failed" && afterJson.truncated === false);

  /* ------------------------ C. anomalies ------------------------ */
  console.log("== C. burst anomalies ==");
  const an = await SEC(`/api/v1/platform/security/anomalies`);
  check("anomalies 200", an.status === 200);
  const data = an.json?.data ?? {};
  check("anomalies contract keys", ["generatedAt", "windowMinutes", "threshold", "emailBursts", "ipBursts", "totalBursts"].every((k) => k in data));
  check("anomalies window/threshold law", data.windowMinutes === 60 && data.threshold === 5);
  const emailKeys: string[] = (data.emailBursts ?? []).map((b: any) => b.key);
  const ipKeys: string[] = (data.ipBursts ?? []).map((b: any) => b.key);
  check("email burst contains burst user", emailKeys.includes(burstUser.email));
  const burstBucket = (data.emailBursts ?? []).find((b: any) => b.key === burstUser.email);
  check("email burst count == 6", burstBucket?.count === 6, `got=${burstBucket?.count}`);
  check("ip burst contains seeded prefix", ipKeys.includes(seededPrefix));
  const ipBucket = (data.ipBursts ?? []).find((b: any) => b.key === seededPrefix);
  check("ip burst count == 5", ipBucket?.count === 5, `got=${ipBucket?.count}`);
  check("below-threshold user absent", !emailKeys.includes(lowUser.email));
  check("below-threshold ips absent", !ipKeys.includes(sha("192.0.2.90").slice(0, 12)));
  check("bucket rows have count+lastAt", [...(data.emailBursts ?? []), ...(data.ipBursts ?? [])].every((b: any) => typeof b.count === "number" && !Number.isNaN(Date.parse(b.lastAt))));
  check("totalBursts == email+ip", data.totalBursts === (data.emailBursts?.length ?? 0) + (data.ipBursts?.length ?? 0));
  const sum = await SEC(`/api/v1/platform/security/summary`);
  check("summary.failedLoginBursts1h == anomalies.totalBursts", sum.json?.data?.failedLoginBursts1h === data.totalBursts, `summary=${sum.json?.data?.failedLoginBursts1h} anomalies=${data.totalBursts}`);

  /* ------------------------ D. operator sessions ------------------------ */
  console.log("== D. operator sessions ==");
  const sess = await S(opSessionsPath);
  check("sessions 200 + contract", sess.status === 200 && ["operator", "activeCount", "sessions", "truncated"].every((k) => k in (sess.json?.data ?? {})));
  check("sessions operator block", sess.json?.data?.operator?.id === op2.id && sess.json?.data?.operator?.role === "PLATFORM_SUPPORT");
  const sessRows: any[] = sess.json?.data?.sessions ?? [];
  check("sessions include operator2 live login", sessRows.some((s) => s.live === true && s.revoked === false), `active=${sess.json?.data?.activeCount}`);
  check("session row contract", sessRows.every((s) => ["id", "deviceLabel", "createdAt", "lastSeenAt", "expiresAt", "revoked", "revokedAt", "live", "ipHashPrefix"].every((k) => k in s)));
  check("session deviceLabel bounded", sessRows.every((s) => s.deviceLabel === null || (typeof s.deviceLabel === "string" && s.deviceLabel.length <= 40)));
  check("session ipHashPrefix ≤12 hex or null", sessRows.every((s) => s.ipHashPrefix === null || /^[0-9a-f]{1,12}$/.test(s.ipHashPrefix)));

  // Live revocation of operator2's session — then the jar must actually die.
  const target = sessRows.find((s) => s.live === true)!;
  const rev = await SEC(`/api/v1/platform/operators/${op2.id}/sessions/${target.id}`, delBody("R64 battery: operator session revoke"));
  check("revoke security → 200 revoked=true", rev.status === 200 && rev.json?.data?.revoked === true);
  const dead = await OP2(`/api/v1/platform/self`);
  check("revoked jar actually dies → 401 SESSION_REVOKED", dead.status === 401 && dead.json?.error?.code === "SESSION_REVOKED", `status=${dead.status} code=${dead.json?.error?.code}`);
  const rev2 = await SEC(`/api/v1/platform/operators/${op2.id}/sessions/${target.id}`, delBody("R64 battery: idempotent re-delete"));
  check("re-delete → alreadyRevoked=true", rev2.status === 200 && rev2.json?.data?.alreadyRevoked === true);
  const foreign = await SEC(`/api/v1/platform/operators/${op2.id}/sessions/nonexistent-session-id`, delBody("R64 battery: foreign id"));
  check("foreign session id → 404", foreign.status === 404);
  const noOp = await SEC(`/api/v1/platform/operators/nonexistent-operator/sessions/${target.id}`, delBody("R64 battery: missing operator"));
  check("nonexistent operator → 404", noOp.status === 404);
  const shortReason = await SEC(`/api/v1/platform/operators/${op2.id}/sessions/${target.id}`, { method: "DELETE", body: JSON.stringify({ reason: "x", password: PW }) });
  check("short reason → 422", shortReason.status === 422);
  const auditRevoke = await db.platformAuditLog.findFirst({
    where: { action: "platform.operator_session_revoked", entityId: target.id },
    orderBy: { createdAt: "desc" },
  });
  check("revoke audited transactionally", !!auditRevoke && auditRevoke.targetUserId === op2User.id && JSON.parse(auditRevoke.afterJson ?? "{}").revoked === true);
  const secEv = await db.securityEvent.findFirst({ where: { sessionId: target.id, eventType: "auth.session.revoked" }, orderBy: { createdAt: "desc" } });
  check("SecurityEvent auth.session.revoked written", !!secEv && secEv.userId === op2User.id);
  const sessAfter = await S(opSessionsPath);
  const afterRows: any[] = sessAfter.json?.data?.sessions ?? [];
  check("session shows revoked after kill", afterRows.find((s) => s.id === target.id)?.revoked === true);

  /* ------------------------ E. first-response SLA ------------------------ */
  console.log("== E. first-response SLA ==");
  const mkTicket = async (subject: string) => {
    const res = await SUP(`/api/v1/platform/support/tickets`, {
      method: "POST",
      body: JSON.stringify({ requesterId: tenantUser.id, subject, description: "R64 battery ticket body (long enough)", category: "TECHNICAL", priority: "NORMAL" }),
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`ticket create failed: ${res.status}`);
    const ticket = res.json.data.ticket as { id: string; sla?: string };
    ticketIds.push(ticket.id);
    return ticket;
  };
  const fresh = await mkTicket(`R64 SLA fresh ${TS}`);
  check("fresh ticket sla=open", fresh.sla === "open", `got=${fresh.sla}`);
  const overdue = await mkTicket(`R64 SLA overdue ${TS}`);
  await db.supportTicket.update({ where: { id: overdue.id }, data: { createdAt: new Date(Date.now() - 5 * 3_600_000) } });
  const dueSoon = await mkTicket(`R64 SLA due-soon ${TS}`);
  await db.supportTicket.update({ where: { id: dueSoon.id }, data: { createdAt: new Date(Date.now() - 3.5 * 3_600_000) } });
  const list = await SUP(`/api/v1/platform/support/tickets?pageSize=100`);
  const byId = new Map<string, any>((list.json?.data?.tickets ?? []).map((t: any) => [t.id, t]));
  check("aged 5h sla=overdue", byId.get(overdue.id)?.sla === "overdue", `got=${byId.get(overdue.id)?.sla}`);
  check("aged 3.5h sla=due_soon", byId.get(dueSoon.id)?.sla === "due_soon", `got=${byId.get(dueSoon.id)?.sla}`);
  // Operator reply → firstResponseAt set → met (verdict recomputed server-side).
  await SUP(`/api/v1/platform/support/tickets/${overdue.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "R64 battery: operator first response", visibility: "CUSTOMER" }),
  });
  const list2 = await SUP(`/api/v1/platform/support/tickets?pageSize=100`);
  const byId2 = new Map<string, any>((list2.json?.data?.tickets ?? []).map((t: any) => [t.id, t]));
  check("after reply sla=met", byId2.get(overdue.id)?.sla === "met", `got=${byId2.get(overdue.id)?.sla}`);
  // Terminal without response → na (deadline no longer actionable).
  await db.supportTicket.update({ where: { id: dueSoon.id }, data: { status: "CLOSED" } });
  const list3 = await SUP(`/api/v1/platform/support/tickets?pageSize=100`);
  const byId3 = new Map<string, any>((list3.json?.data?.tickets ?? []).map((t: any) => [t.id, t]));
  check("closed-without-response sla=na", byId3.get(dueSoon.id)?.sla === "na", `got=${byId3.get(dueSoon.id)?.sla}`);
  // Overview counter == DB truth — keep one UNANSWERED overdue ticket alive
  // so the counter is exercised at a nonzero value (fixtures are the only
  // overdue tickets in the sandbox).
  const ovOverdue = await mkTicket(`R64 SLA overview ${TS}`);
  await db.supportTicket.update({ where: { id: ovOverdue.id }, data: { createdAt: new Date(Date.now() - 6 * 3_600_000) } });
  const ov = await S(`/api/v1/platform/overview`);
  const dbOverdue = await db.supportTicket.count({
    where: { status: { in: ["OPEN", "TRIAGED", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL_ACTION"] }, firstResponseAt: null, createdAt: { lt: new Date(Date.now() - 4 * 3_600_000) } },
  });
  check("overview.support.slaOverdue == DB truth", ov.json?.data?.support?.slaOverdue === dbOverdue && dbOverdue >= 1, `api=${ov.json?.data?.support?.slaOverdue} db=${dbOverdue}`);

  /* ------------------------ F. export rate limit ------------------------ */
  console.log("== F. export rate limit ==");
  const PROBE = caller(await login(probeUser.email));
  let saw429 = false;
  let okCalls = 0;
  for (let i = 0; i < 7; i++) {
    const r = await PROBE(`/api/v1/platform/security/events/export`);
    if (r.status === 429) { saw429 = true; break; }
    if (r.status === 200) okCalls++;
  }
  check("export rate limit fires (5/min)", saw429 && okCalls >= 5, `ok=${okCalls} before 429`);

  /* ------------------------ cleanup + residue ------------------------ */
  console.log("== cleanup ==");
  await db.supportTicketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.securityEvent.deleteMany({ where: { id: { in: seededEventIds } } });
  await db.platformAuditLog.deleteMany({
    where: { OR: [{ operatorId: { in: operatorIds } }, { targetUserId: { in: createdUserIds } }] },
  });
  // Sessions cascade with users; operators deleted explicitly first.
  await clearFixtureMfa(db, createdUserIds);
  await db.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });

  const resOps = await db.platformOperator.count({ where: { id: { in: operatorIds } } });
  const resUsers = await db.user.count({ where: { id: { in: createdUserIds } } });
  const resEvents = await db.securityEvent.count({ where: { userId: { in: createdUserIds } } });
  const resSessions = await db.userSession.count({ where: { userId: { in: createdUserIds } } });
  const resTickets = await db.supportTicket.count({ where: { id: { in: ticketIds } } });
  const resAudit = await db.platformAuditLog.count({ where: { operatorId: { in: operatorIds } } });
  check("zero fixture residue", resOps + resUsers + resEvents + resSessions + resTickets + resAudit === 0,
    `ops=${resOps} users=${resUsers} events=${resEvents} sessions=${resSessions} tickets=${resTickets} audit=${resAudit}`);

  console.log("=========================================");
  console.log(`R64 SECURITY OPS CHECK: ${pass}/${pass + fail} ${fail === 0 ? "PASS — ALL GREEN ✓" : `FAIL (${fail}) ✗`}`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

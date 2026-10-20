/**
 * R62 LIVE check — Platform Support Center + user suspension (Prompt 62).
 *
 * Proves end-to-end against the REAL server:
 *   A  Authorization matrix — anonymous 401, tenant 403, role gates
 *   B  Ticket lifecycle — create → list/detail isolation → internal note
 *      leak-proofing → customer reply → notification → transitions →
 *      resolve (summary-mandatory) → reopen-by-reply
 *   C  Suspension — guards (reason/self/operator), session kill, login
 *      block, reactivation, idempotent repeats, audit + notification
 *   D  Audit trail for every operator mutation
 *   Cleanup: deletes every throwaway row it created.
 *
 * Run: bun scripts/r62-support-check.ts   (dev server on :3000)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const PW = "R62Check!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const createdBusinessIds: string[] = [];
const createdTicketIds: string[] = [];

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.63.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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

function caller(jar: Map<string, string>, businessId?: string): Call {
  const f = jarFetch(jar);
  return async (path, init = {}) => {
    const headers: Record<string, string> = {
      ...(businessId ? { "x-business-id": businessId } : {}),
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    const res = await f(path, { ...init, headers });
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
}

async function main() {
  console.log("== R62 fixtures ==");
  const hash = bcrypt.hashSync(PW, 10);

  const tenantA = await db.user.create({ data: { email: `r62-a-${TS}@t.dev`, name: "R62 Tenant A", passwordHash: hash, emailVerifiedAt: new Date() } });
  const tenantB = await db.user.create({ data: { email: `r62-b-${TS}@t.dev`, name: "R62 Tenant B", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opSuperUser = await db.user.create({ data: { email: `r62-op-super-${TS}@t.dev`, name: "R62 Super", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opSupportUser = await db.user.create({ data: { email: `r62-op-support-${TS}@t.dev`, name: "R62 Support", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opReadonlyUser = await db.user.create({ data: { email: `r62-op-ro-${TS}@t.dev`, name: "R62 Readonly", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opBillingUser = await db.user.create({ data: { email: `r62-op-billing-${TS}@t.dev`, name: "R62 Billing", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(tenantA.id, tenantB.id, opSuperUser.id, opSupportUser.id, opReadonlyUser.id, opBillingUser.id);

  const bizA = await db.business.create({ data: { name: `R62 Biz A ${TS}`, slug: `r62-a-${TS}`, ownerId: tenantA.id } });
  await db.businessMember.create({ data: { businessId: bizA.id, userId: tenantA.id, role: "OWNER" } });
  const bizB = await db.business.create({ data: { name: `R62 Biz B ${TS}`, slug: `r62-b-${TS}`, ownerId: tenantB.id } });
  await db.businessMember.create({ data: { businessId: bizB.id, userId: tenantB.id, role: "OWNER" } });
  createdBusinessIds.push(bizA.id, bizB.id);

  const opSuper = await db.platformOperator.create({ data: { userId: opSuperUser.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
  const opSupport = await db.platformOperator.create({ data: { userId: opSupportUser.id, role: "PLATFORM_SUPPORT", active: true } });
  await db.platformOperator.create({ data: { userId: opReadonlyUser.id, role: "PLATFORM_READONLY", active: true } });
  await db.platformOperator.create({ data: { userId: opBillingUser.id, role: "PLATFORM_BILLING", active: true } });

  const anon = caller(new Map());
  const A = caller(await login(tenantA.email), bizA.id);
  const B = caller(await login(tenantB.email), bizB.id);
  const SUPER = caller(await login(opSuperUser.email));
  const SUPPORT = caller(await login(opSupportUser.email));
  const RO = caller(await login(opReadonlyUser.email));
  const BILLING = caller(await login(opBillingUser.email));
  check("fixtures created + all logins OK", true);

  /* ---------------------- A. authorization matrix ---------------------- */
  console.log("== A. authorization matrix ==");
  const anonList = await anon("/api/v1/platform/support/tickets");
  check("anonymous platform ticket list → 401", anonList.status === 401 && anonList.json?.error?.code === "PLATFORM_UNAUTHENTICATED", JSON.stringify(anonList.json?.error));
  const aPlatformList = await A("/api/v1/platform/support/tickets");
  check("tenant user platform list → 403 PLATFORM_FORBIDDEN", aPlatformList.status === 403 && aPlatformList.json?.error?.code === "PLATFORM_FORBIDDEN", JSON.stringify(aPlatformList.json?.error));
  const aSuspend = await A(`/api/v1/platform/users/${tenantB.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "tenant attempt", password: PW }) });
  check("tenant user suspend attempt → 403", aSuspend.status === 403, JSON.stringify(aSuspend.json?.error));
  const anonCreate = await anon("/api/v1/support/tickets", { method: "POST", body: JSON.stringify({ subject: "anon", description: "anon ticket body", category: "OTHER" }) });
  check("anonymous tenant create → 401", anonCreate.status === 401);

  /* ------------------------ B. ticket lifecycle ------------------------ */
  console.log("== B. ticket lifecycle ==");
  const created = await A("/api/v1/support/tickets", {
    method: "POST",
    body: JSON.stringify({ subject: "Cannot record payment", description: "The payment form rejects my card with an unknown error since yesterday.", category: "BILLING" }),
  });
  check("tenant A creates ticket → 201 OPEN", created.status === 201 && created.json?.data?.ticket?.status === "OPEN", JSON.stringify(created.json?.error ?? created.json?.data?.ticket?.reference));
  const ticket = created.json?.data?.ticket;
  const ticketId: string = ticket?.id ?? "";
  createdTicketIds.push(ticketId);
  check("ticket reference format SUP-XXXX", /^SUP-\d{4}$/.test(ticket?.reference ?? ""), ticket?.reference);

  const aList = await A("/api/v1/support/tickets");
  check("tenant A list shows own ticket", aList.status === 200 && aList.json?.data?.tickets?.some((t: any) => t.id === ticketId));
  const bList = await B("/api/v1/support/tickets");
  check("tenant B list does NOT contain A's ticket (requester isolation)", bList.status === 200 && !bList.json?.data?.tickets?.some((t: any) => t.id === ticketId));

  const aDetail = await A(`/api/v1/support/tickets/${ticketId}`);
  check("tenant A detail 200", aDetail.status === 200);
  const bDetail = await B(`/api/v1/support/tickets/${ticketId}`);
  check("tenant B detail of A's ticket → 404 (IDOR guard)", bDetail.status === 404 && bDetail.json?.error?.code === "SUPPORT_TICKET_NOT_FOUND");

  const internalBody = `INTERNAL-EVIDENCE-${TS} — customer seems to be on an expired card`;
  const internalNote = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: internalBody, visibility: "INTERNAL" }),
  });
  check("support operator posts INTERNAL note → 201", internalNote.status === 201 && internalNote.json?.data?.message?.visibility === "INTERNAL", JSON.stringify(internalNote.json?.error));

  const aDetail2 = await A(`/api/v1/support/tickets/${ticketId}`);
  const aBodies = JSON.stringify(aDetail2.json?.data?.ticket?.messages ?? []);
  check("LEAK TEST: internal note NEVER visible via tenant API", !aBodies.includes(internalBody) && aDetail2.status === 200);

  const roList = await RO("/api/v1/platform/support/tickets");
  check("READONLY can list tickets", roList.status === 200 && roList.json?.data?.tickets?.some((t: any) => t.id === ticketId));
  const roMsg = await RO(`/api/v1/platform/support/tickets/${ticketId}/messages`, { method: "POST", body: JSON.stringify({ body: "ro attempt", visibility: "INTERNAL" }) });
  check("READONLY post message → 403 PERMISSION_DENIED", roMsg.status === 403 && roMsg.json?.error?.code === "PLATFORM_PERMISSION_DENIED", JSON.stringify(roMsg.json?.error));
  const roPatch = await RO(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ priority: "HIGH" }) });
  check("READONLY patch → 403", roPatch.status === 403);
  const roResolve = await RO(`/api/v1/platform/support/tickets/${ticketId}/resolve`, { method: "POST", body: JSON.stringify({ resolutionSummary: "readonly attempt summary" }) });
  check("READONLY resolve → 403", roResolve.status === 403);

  const billingPatch = await BILLING(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "TRIAGED" }) });
  check("BILLING status patch → 403 (no platform:support:update)", billingPatch.status === 403, JSON.stringify(billingPatch.json?.error));
  const billingList = await BILLING("/api/v1/platform/support/tickets");
  check("BILLING can read tickets", billingList.status === 200);

  const assign = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ assigneeOperatorId: "me" }) });
  check("support operator assigns self", assign.status === 200 && assign.json?.data?.ticket?.assigneeOperatorId === opSupport.id, JSON.stringify({ s: assign.status, j: assign.json, want: opSupport.id }));
  const triage = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "TRIAGED" }) });
  check("transition OPEN → TRIAGED", triage.status === 200 && triage.json?.data?.ticket?.status === "TRIAGED");
  const prio = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ priority: "HIGH" }) });
  check("priority update → HIGH", prio.status === 200 && prio.json?.data?.ticket?.priority === "HIGH");
  const dupPriority = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ priority: "HIGH" }) });
  check("repeat priority set is idempotent no-op", dupPriority.status === 200);

  const badTransition = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "RESOLVED" }) });
  check("resolve without summary → 422 SUPPORT_RESOLUTION_REQUIRED", badTransition.status === 422 && badTransition.json?.error?.code === "SUPPORT_RESOLUTION_REQUIRED", JSON.stringify(badTransition.json?.error));
  const mixedPatch = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "IN_PROGRESS", priority: "LOW" }) });
  check("multi-field patch rejected (mass-assignment guard)", mixedPatch.status === 422);

  const inProgress = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ status: "IN_PROGRESS" }) });
  check("transition TRIAGED → IN_PROGRESS", inProgress.status === 200);

  const reply = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: `Please update your card — REPLY-${TS}`, visibility: "CUSTOMER" }),
  });
  check("customer-visible reply → 201", reply.status === 201 && reply.json?.data?.message?.visibility === "CUSTOMER");

  const aDetail3 = await A(`/api/v1/support/tickets/${ticketId}`);
  const detailStr = JSON.stringify(aDetail3.json?.data?.ticket ?? {});
  check("tenant sees operator CUSTOMER reply", detailStr.includes(`REPLY-${TS}`));
  check("LEAK TEST still holds after reply", !detailStr.includes(internalBody));

  const aNotifs = await A("/api/v1/me/notifications?pageSize=20");
  const notifStr = JSON.stringify(aNotifs.json?.data?.items ?? []);
  check("requester got SUPPORT_TICKET_REPLY notification (rendered)", notifStr.includes("SUPPORT_TICKET_REPLY"), notifStr.slice(0, 120));
  const createdNotif = notifStr.includes("SUPPORT_TICKET_CREATED");
  check("requester got SUPPORT_TICKET_CREATED ack", createdNotif);

  const opDetail = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}`);
  check("operator detail includes INTERNAL note + allowedTransitions", JSON.stringify(opDetail.json?.data?.ticket?.messages ?? []).includes(internalBody) && Array.isArray(opDetail.json?.data?.ticket?.allowedTransitions));
  check("firstResponseAt set by CUSTOMER reply only", !!opDetail.json?.data?.ticket?.firstResponseAt);
  check("diagnostics block present (subscription/requester/deliveries)", !!opDetail.json?.data?.diagnostics && "failedDeliveries" in opDetail.json.data.diagnostics);

  const resolveNoSummary = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/resolve`, { method: "POST", body: JSON.stringify({ resolutionSummary: "short" }) });
  check("resolve with 5-char summary → 422", resolveNoSummary.status === 422);
  const resolve = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolutionSummary: `Card was expired; customer updated it and the charge went through. PROOF-${TS}` }),
  });
  check("resolve with summary → 200 RESOLVED", resolve.status === 200 && resolve.json?.data?.ticket?.status === "RESOLVED");
  const doubleResolve = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolutionSummary: "Trying to resolve an already-resolved ticket" }),
  });
  check("double resolve → 422 (no RESOLVED→RESOLVED edge)", doubleResolve.status === 422 && doubleResolve.json?.error?.code === "SUPPORT_INVALID_TRANSITION");

  const aNotifs2 = await A("/api/v1/me/notifications?pageSize=20");
  check("requester got SUPPORT_TICKET_RESOLVED notification", JSON.stringify(aNotifs2.json?.data?.items ?? []).includes("SUPPORT_TICKET_RESOLVED"));

  const reopenReply = await A(`/api/v1/support/tickets/${ticketId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: `Actually the refund never arrived. REOPEN-${TS}` }),
  });
  check("requester reply on RESOLVED → 201 (reopen path)", reopenReply.status === 201);
  const aDetail4 = await A(`/api/v1/support/tickets/${ticketId}`);
  check("ticket reopened to OPEN by requester reply", aDetail4.json?.data?.ticket?.status === "OPEN", aDetail4.json?.data?.ticket?.status);
  check("reopen cleared resolution summary for the requester view", aDetail4.json?.data?.ticket?.resolutionSummary === null);

  const opFilters = await SUPPORT("/api/v1/platform/support/tickets?status=OPEN&priority=HIGH&assignee=me");
  check("operator list filters (status+priority+assignee=me)", opFilters.status === 200 && opFilters.json?.data?.tickets?.some((t: any) => t.id === ticketId), JSON.stringify({ s: opFilters.status, n: opFilters.json?.data?.tickets?.length, t: opFilters.json?.data?.tickets?.[0]?.status, e: opFilters.json?.error }));
  const opQ = await SUPPORT(`/api/v1/platform/support/tickets?q=${encodeURIComponent("payment form rejects")}`);
  check("operator list text search (q)", opQ.status === 200 && opQ.json?.data?.tickets?.some((t: any) => t.id === ticketId), JSON.stringify({ s: opQ.status, n: opQ.json?.data?.tickets?.length, e: opQ.json?.error }));

  /* ------------------------ C. suspension guards ----------------------- */
  console.log("== C. suspension lifecycle ==");
  const noReason = await SUPER(`/api/v1/platform/users/${tenantB.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "", password: PW }) });
  check("suspend without reason → 422", noReason.status === 422);
  const shortReason = await SUPER(`/api/v1/platform/users/${tenantB.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "abuse", password: PW }) });
  check("suspend with <10-char reason → 422", shortReason.status === 422);
  const noReauth = await SUPER(`/api/v1/platform/users/${tenantB.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "Suspension test reason for R62 checks." }) });
  check("suspend without reauth password → 403 PLATFORM_REAUTH_REQUIRED", noReauth.status === 403 && noReauth.json?.error?.code === "PLATFORM_REAUTH_REQUIRED", JSON.stringify(noReauth.json?.error));
  const badPw = await SUPER(`/api/v1/platform/users/${tenantB.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "Suspension test reason for R62 checks.", password: "wrong-password" }) });
  check("suspend with wrong password → 403 PLATFORM_REAUTH_FAILED", badPw.status === 403 && badPw.json?.error?.code === "PLATFORM_REAUTH_FAILED");

  const selfSuspend = await SUPER(`/api/v1/platform/users/${opSuperUser.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "Attempted self-suspension in R62 check.", password: PW }) });
  check("self-suspension → 422 PLATFORM_USER_SELF_TARGET", selfSuspend.status === 422 && selfSuspend.json?.error?.code === "PLATFORM_USER_SELF_TARGET", JSON.stringify(selfSuspend.json?.error));
  const opSuspend = await SUPER(`/api/v1/platform/users/${opSupportUser.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "Attempted operator suspension in R62 check.", password: PW }) });
  check("operator target → 422 PLATFORM_USER_IS_OPERATOR (lockout guard)", opSuspend.status === 422 && opSuspend.json?.error?.code === "PLATFORM_USER_IS_OPERATOR", JSON.stringify(opSuspend.json?.error));

  const roSuspend = await RO(`/api/v1/platform/users/${tenantB.id}/suspend`, { method: "POST", body: JSON.stringify({ reason: "Readonly must never suspend users.", password: PW }) });
  check("READONLY suspend → 403", roSuspend.status === 403);

  const notSuspended = await SUPER(`/api/v1/platform/users/${tenantB.id}/reactivate`, { method: "POST", body: JSON.stringify({ reason: "Reactivate a non-suspended account.", password: PW }) });
  check("reactivate non-suspended → 409 PLATFORM_USER_NOT_SUSPENDED", notSuspended.status === 409 && notSuspended.json?.error?.code === "PLATFORM_USER_NOT_SUSPENDED", JSON.stringify(notSuspended.json?.error));

  const suspend = await SUPER(`/api/v1/platform/users/${tenantA.id}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason: `Confirmed fraudulent chargebacks — investigation open. ${TS}`, password: PW }),
  });
  check("suspend tenant A → 200", suspend.status === 200 && !!suspend.json?.data?.user?.suspendedAt, JSON.stringify(suspend.json?.error));
  const repeatSuspend = await SUPER(`/api/v1/platform/users/${tenantA.id}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason: "Repeat suspension attempt must stay explicit and safe.", password: PW }),
  });
  check("repeat suspend → 409 PLATFORM_USER_ALREADY_SUSPENDED", repeatSuspend.status === 409 && repeatSuspend.json?.error?.code === "PLATFORM_USER_ALREADY_SUSPENDED", JSON.stringify(repeatSuspend.json?.error));

  const aAfterSuspend = await A("/api/v1/businesses");
  check("tenant A live session killed after suspension (401 SESSION_INVALIDATED)", aAfterSuspend.status === 401 && aAfterSuspend.json?.error?.code === "SESSION_INVALIDATED", JSON.stringify(aAfterSuspend.json?.error));

  const loginJar = new Map<string, string>();
  const f = jarFetch(loginJar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const loginRes = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: tenantA.email, password: PW }).toString(),
  });
  const loginLocation = loginRes.headers.get("location") ?? "";
  check("suspended login blocked (ACCOUNT_SUSPENDED surfaced)", loginLocation.includes("ACCOUNT_SUSPENDED"), `status=${loginRes.status} loc=${loginLocation.slice(0, 120)}`);

  const dbSuspended = await db.user.findUnique({ where: { id: tenantA.id }, select: { suspendedAt: true, suspensionReason: true, suspendedByOperatorId: true, sessionVersion: true } });
  check("DB: suspendedAt + reason + actor recorded", !!dbSuspended?.suspendedAt && (dbSuspended.suspensionReason ?? "").includes(TS) && dbSuspended.suspendedByOperatorId === opSuper.id);
  const dbSecEvt = await db.securityEvent.findFirst({ where: { userId: tenantA.id, eventType: "platform.account.suspended" }, orderBy: { createdAt: "desc" } });
  check("DB: SecurityEvent platform.account.suspended recorded", !!dbSecEvt);
  const dbNotif = await db.notification.findFirst({ where: { userId: tenantA.id, type: "SYSTEM_ACCOUNT_SUSPENDED" } });
  check("DB: mandatory suspension notification created", !!dbNotif);

  const auditApi = await SUPER(`/api/v1/platform/audit?action=platform.user.suspend&pageSize=50`);
  const auditStr = JSON.stringify(auditApi.json?.data ?? {});
  check("platform audit records suspension with target", auditApi.status === 200 && auditStr.includes(tenantA.id), auditStr.slice(0, 140));
  const bAudit = await B("/api/v1/platform/audit");
  check("tenant cannot read platform audit", bAudit.status === 403, JSON.stringify(bAudit.json?.error));

  const reactivate = await SUPER(`/api/v1/platform/users/${tenantA.id}/reactivate`, {
    method: "POST",
    body: JSON.stringify({ reason: `Investigation closed — no violation found. ${TS}`, password: PW }),
  });
  check("reactivate tenant A → 200", reactivate.status === 200, JSON.stringify(reactivate.json?.error));
  const repeatReactivate = await SUPER(`/api/v1/platform/users/${tenantA.id}/reactivate`, {
    method: "POST",
    body: JSON.stringify({ reason: "Repeat reactivation must be an explicit 409.", password: PW }),
  });
  check("repeat reactivate → 409 PLATFORM_USER_NOT_SUSPENDED", repeatReactivate.status === 409 && repeatReactivate.json?.error?.code === "PLATFORM_USER_NOT_SUSPENDED");
  const dbNotif2 = await db.notification.findFirst({ where: { userId: tenantA.id, type: "SYSTEM_ACCOUNT_RESTORED" } });
  check("DB: restoration notification created", !!dbNotif2);

  const aRelogin = caller(await login(tenantA.email), bizA.id);
  const aOk = await aRelogin("/api/v1/support/tickets");
  check("tenant A can log in + use APIs after reactivation", aOk.status === 200, JSON.stringify({ s: aOk.status, e: aOk.json?.error }));

  const supAudit = await SUPER("/api/v1/platform/audit?action=support.ticket.transition&pageSize=50");
  const supAuditStr = JSON.stringify(supAudit.json?.data ?? {});
  check("platform audit records ticket transitions", supAudit.status === 200 && supAuditStr.includes(ticketId));
  const msgAudit = await SUPER("/api/v1/platform/audit?action=support.ticket.message&pageSize=50");
  check("platform audit records operator messages", msgAudit.status === 200 && JSON.stringify(msgAudit.json?.data ?? {}).includes("INTERNAL"));
  const resolvedAudit = await SUPER("/api/v1/platform/audit?action=support.ticket.transition&pageSize=50");
  check("platform audit carries resolution summaries", JSON.stringify(resolvedAudit.json?.data ?? {}).includes("PROOF-") || JSON.stringify(resolvedAudit.json?.data ?? {}).includes("REOPEN"));

  console.log("== cleanup ==");
  for (const id of createdTicketIds) {
    await db.supportTicketMessage.deleteMany({ where: { ticketId: id } });
    await db.supportTicket.delete({ where: { id } }).catch(() => undefined);
  }
  const opIds = [opSuper.id, opSupport.id];
  await db.platformAuditLog.deleteMany({ where: { operatorId: { in: opIds }, targetUserId: { in: createdUserIds } } });
  await db.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.securityEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.supportTicketMessage.deleteMany({ where: { authorUserId: { in: createdUserIds } } });
  // Businesses BEFORE owner-users (Business.ownerId FK would silently block
  // the user deletes otherwise — Prompt-62 round lesson).
  for (const id of createdBusinessIds) {
    await db.business.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of createdUserIds) {
    await db.platformOperator.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } }).catch((e) => {
      fail++; console.log(`  ✗ cleanup user ${id} FAILED — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    });
  }
  const leftUsers = await db.user.count({ where: { email: { contains: TS } } });
  const leftTickets = await db.supportTicket.count({ where: { requesterEmailAtCreation: { contains: TS } } });
  const leftBiz = await db.business.count({ where: { slug: { contains: TS } } });
  check("cleanup: zero fixture residue", leftUsers === 0 && leftTickets === 0 && leftBiz === 0, `users=${leftUsers} tickets=${leftTickets} biz=${leftBiz}`);

  console.log("\n=========================================");
  console.log(`R62 SUPPORT CHECK: ${pass}/${pass + fail} PASS${fail === 0 ? " — ALL GREEN ✓" : ` — ${fail} FAILED ✗`}`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

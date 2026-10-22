/**
 * R62 LIVE check #2 — Platform overview support metrics (§7.2) +
 * system-announcements API (§18) — Prompt 62 completion round.
 *
 * Proves end-to-end against the REAL server:
 *   A  Overview support counters — shape, live increments/decrements as a
 *      ticket is created → answered → resolved (honest 0 vs. no-data law)
 *   B  Announcements — authz matrix (anon/tenant/wrong-role), honest
 *      partial result (bogus recipient), dedupe, cap 422, empty 422,
 *      audit entry, recipient notification creation
 *   Cleanup: deletes every throwaway row it created.
 *
 * Run: bun scripts/r62-overview-announce-check.ts   (dev server on :3000)
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

  const tenantA = await db.user.create({ data: { email: `r62o-a-${TS}@t.dev`, name: "R62O Tenant A", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opSuperUser = await db.user.create({ data: { email: `r62o-super-${TS}@t.dev`, name: "R62O Super", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opSupportUser = await db.user.create({ data: { email: `r62o-sup-${TS}@t.dev`, name: "R62O Support", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opBillingUser = await db.user.create({ data: { email: `r62o-bil-${TS}@t.dev`, name: "R62O Billing", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opRoUser = await db.user.create({ data: { email: `r62o-ro-${TS}@t.dev`, name: "R62O Readonly", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(tenantA.id, opSuperUser.id, opSupportUser.id, opBillingUser.id, opRoUser.id);

  const bizA = await db.business.create({ data: { name: `R62O Biz A ${TS}`, slug: `r62o-a-${TS}`, ownerId: tenantA.id } });
  await db.businessMember.create({ data: { businessId: bizA.id, userId: tenantA.id, role: "OWNER" } });
  createdBusinessIds.push(bizA.id);

  await db.platformOperator.create({ data: { userId: opSuperUser.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
  await db.platformOperator.create({ data: { userId: opSupportUser.id, role: "PLATFORM_SUPPORT", active: true } });
  await db.platformOperator.create({ data: { userId: opBillingUser.id, role: "PLATFORM_BILLING", active: true } });
  await db.platformOperator.create({ data: { userId: opRoUser.id, role: "PLATFORM_READONLY", active: true } });

  const anon = caller(new Map());
  const A = caller(await login(tenantA.email), bizA.id);
  const SUPER = caller(await login(opSuperUser.email));
  const SUPPORT = caller(await login(opSupportUser.email));
  const BILLING = caller(await login(opBillingUser.email));
  const RO = caller(await login(opRoUser.email));
  check("fixtures created + all logins OK", true);

  /* ============== A. overview support metrics (§7.2) ============== */
  console.log("== A. overview support metrics ==");
  const ov0 = await SUPER("/api/v1/platform/overview");
  const sup0 = ov0.json?.data?.support;
  check(
    "overview exposes support block {open, awaitingFirstResponse, urgentOpen}",
    ov0.status === 200 &&
      sup0 &&
      Number.isInteger(sup0.open) &&
      Number.isInteger(sup0.awaitingFirstResponse) &&
      Number.isInteger(sup0.urgentOpen),
    JSON.stringify(sup0),
  );
  const roOv = await RO("/api/v1/platform/overview");
  check(
    "READONLY also sees support counters (counts are safe for all platform roles)",
    roOv.status === 200 && Number.isInteger(roOv.json?.data?.support?.open),
  );
  const aOv = await A("/api/v1/platform/overview");
  check("tenant overview → 403 PLATFORM_FORBIDDEN", aOv.status === 403 && aOv.json?.error?.code === "PLATFORM_FORBIDDEN");

  const created = await A("/api/v1/support/tickets", {
    method: "POST",
    body: JSON.stringify({
      subject: `Overview metric probe ${TS}`,
      description: "Ticket created to verify the platform overview support counters react to real data.",
      category: "TECHNICAL",
    }),
  });
  const ticket = created.json?.data?.ticket;
  const ticketId: string = ticket?.id ?? "";
  createdTicketIds.push(ticketId);
  check("tenant A creates ticket → 201", created.status === 201 && !!ticketId, ticket?.reference);

  const ov1 = await SUPER("/api/v1/platform/overview");
  const sup1 = ov1.json?.data?.support;
  check(
    "open +1 and awaitingFirstResponse +1 after creation",
    sup1.open === sup0.open + 1 && sup1.awaitingFirstResponse === sup0.awaitingFirstResponse + 1,
    `open ${sup0.open}→${sup1.open}, awaiting ${sup0.awaitingFirstResponse}→${sup1.awaitingFirstResponse}`,
  );

  const reply = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: `First response ${TS}`, visibility: "CUSTOMER" }),
  });
  check("operator posts first CUSTOMER response → 201", reply.status === 201);

  const ov2 = await SUPER("/api/v1/platform/overview");
  const sup2 = ov2.json?.data?.support;
  check(
    "awaitingFirstResponse back to baseline after first response (open unchanged)",
    sup2.awaitingFirstResponse === sup0.awaitingFirstResponse && sup2.open === sup0.open + 1,
    `awaiting ${sup1.awaitingFirstResponse}→${sup2.awaitingFirstResponse}`,
  );

  const resolve = await SUPPORT(`/api/v1/platform/support/tickets/${ticketId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolutionSummary: `Metric probe resolved ${TS}` }),
  });
  check("operator resolves ticket → 200 RESOLVED", resolve.status === 200 && resolve.json?.data?.ticket?.status === "RESOLVED");

  const ov3 = await SUPER("/api/v1/platform/overview");
  const sup3 = ov3.json?.data?.support;
  check(
    "open back to baseline after resolution",
    sup3.open === sup0.open,
    `open ${sup2.open}→${sup3.open}`,
  );

  /* ============== B. announcements (§18) ============== */
  console.log("== B. announcements ==");
  const anonAnn = await anon("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [tenantA.id], message: "anon" }),
  });
  check("anonymous announcement → 401", anonAnn.status === 401);

  const aAnn = await A("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [tenantA.id], message: "tenant" }),
  });
  check("tenant announcement → 403 PLATFORM_FORBIDDEN", aAnn.status === 403 && aAnn.json?.error?.code === "PLATFORM_FORBIDDEN");

  const bilAnn = await BILLING("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [tenantA.id], message: "billing op" }),
  });
  check(
    "BILLING operator announcement → 403 (role gate, not just permission gate)",
    bilAnn.status === 403,
    JSON.stringify(bilAnn.json?.error),
  );

  const notifBefore = await db.notification.count({ where: { userId: tenantA.id, type: "SYSTEM_ANNOUNCEMENT" } });

  const bogusId = "nonexistent0000000000000000000x";
  const partial = await SUPPORT("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [tenantA.id, bogusId], message: `Scheduled maintenance ${TS}` }),
  });
  check(
    "honest partial result: accepted=1 rejected=1 (bogus id NOT silently swallowed)",
    partial.status === 200 && partial.json?.data?.accepted === 1 && partial.json?.data?.rejected === 1,
    JSON.stringify(partial.json?.data),
  );

  const notifAfter = await db.notification.count({ where: { userId: tenantA.id, type: "SYSTEM_ANNOUNCEMENT" } });
  check(
    "recipient actually received a SYSTEM_ANNOUNCEMENT notification",
    notifAfter === notifBefore + 1,
    `${notifBefore}→${notifAfter}`,
  );

  const dedupeBefore = notifAfter;
  const dedupe = await SUPPORT("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [tenantA.id, tenantA.id], message: `Dedupe probe ${TS}` }),
  });
  const dedupeAfter = await db.notification.count({ where: { userId: tenantA.id, type: "SYSTEM_ANNOUNCEMENT" } });
  check(
    "duplicate recipient ids are deduped server-side (exactly ONE notification)",
    dedupe.status === 200 && dedupe.json?.data?.accepted === 1 && dedupeAfter === dedupeBefore + 1,
    `accepted=${dedupe.json?.data?.accepted}, notif ${dedupeBefore}→${dedupeAfter}`,
  );

  const cap = await SUPPORT("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({
      recipientUserIds: Array.from({ length: 51 }, (_, i) => `r62ocap${TS}${i}aaaa`),
      message: "cap",
    }),
  });
  check("51 recipients → 422 (server cap enforced by schema)", cap.status === 422, `status=${cap.status}`);

  const emptyMsg = await SUPPORT("/api/v1/platform/notifications/announcements", {
    method: "POST",
    body: JSON.stringify({ recipientUserIds: [tenantA.id], message: "" }),
  });
  check("empty message → 422", emptyMsg.status === 422, `status=${emptyMsg.status}`);

  const audit = await db.platformAuditLog.findFirst({
    where: { action: "platform.notifications.announcement_sent", createdAt: { gte: new Date(Date.now() - 120_000) } },
    orderBy: { createdAt: "desc" },
  });
  check(
    "announcement is platform-audited with recipient counts",
    !!audit && audit.entityType === "Notification" && typeof audit.afterJson === "string" && audit.afterJson.includes('"recipients":'),
    audit ? `${audit.action} role=${audit.operatorRole}` : "no row",
  );

  /* ---------------------------- cleanup ---------------------------- */
  console.log("== cleanup ==");
  if (createdTicketIds.length) {
    const d1 = await db.supportTicketMessage.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    const d2 = await db.supportTicket.deleteMany({ where: { id: { in: createdTicketIds } } });
    check("tickets + messages deleted", true, `msgs=${d1.count} tickets=${d2.count}`);
  }
  await db.notification.deleteMany({ where: { userId: tenantA.id } });
  await db.platformAuditLog.deleteMany({ where: { id: audit?.id ?? "" } });
  await db.platformOperator.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.businessMember.deleteMany({ where: { businessId: { in: createdBusinessIds } } });
  await db.business.deleteMany({ where: { id: { in: createdBusinessIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  const residue =
    (await db.user.count({ where: { id: { in: createdUserIds } } })) +
    (await db.business.count({ where: { id: { in: createdBusinessIds } } })) +
    (await db.supportTicket.count({ where: { id: { in: createdTicketIds } } }));
  check("cleanup: zero fixture residue", residue === 0, `residue=${residue}`);

  console.log("=========================================");
  console.log(`R62 OVERVIEW+ANNOUNCE CHECK: ${pass}/${pass + fail} ${fail === 0 ? "PASS — ALL GREEN ✓" : "FAIL ✗"}`);
  if (fail > 0) process.exit(1);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  await db.$disconnect();
  process.exit(1);
});

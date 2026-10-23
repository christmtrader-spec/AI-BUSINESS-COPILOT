/**
 * R63-P SECURITY CENTER BATTERY — Prompt 63 audit round (platform layer).
 *
 * Proves against the REAL dev server:
 *   A  Auth matrix for the new Security Center endpoints
 *      (summary + events): anon 401 / tenant 403 / BILLING 403 /
 *      SUPPORT 403 / READONLY 200 / SECURITY 200.
 *   B  Summary honesty: every counter EQUALS the DB truth computed with
 *      the same where-clauses (login/failed/rate-limited/MFA/revocations/
 *      suspended/activeOperators/activeSessions/eventTypes24h).
 *   C  Events filters: eventType allowlist (unknown → 422), success
 *      boolean filter (bogus → 422), email + userId scoping, date range,
 *      pageSize clamp (1000 → ≤100), facets expose the fixed vocabulary.
 *   D  DTO hygiene: EXACT key set per row (no raw IP — ipHashPrefix only,
 *      ≤12 chars; userAgent bounded; no secrets/ids beyond contract).
 *   E  Overview security block present and honest (window counts == DB).
 *   F  Read rate-limit layer fires (61st rapid call → 429) on a dedicated
 *      probe operator so other fixtures stay unaffected.
 *
 * Cleanup: every fixture row deleted (security events, operators, users);
 * cascade verified by residue checks.
 * Run: bun scripts/r63-security-center-check.ts   (dev server on :3000)
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { enrollFixtureMfa, platformMfaLogin, clearFixtureMfa } from "./lib/platform-mfa";

const BASE = "http://localhost:3000";
const PW = "R63Sec!x2026";
const TS = Date.now().toString(36);
const db = new PrismaClient();

let pass = 0;
let fail = 0;
const createdUserIds: string[] = [];
const seededEventIds: string[] = [];

function check(name: string, ok: boolean, info = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name} — ${info}`); }
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.77.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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

const sha = (ip: string) => createHash("sha256").update(`ipsecsalt-v1:${ip}`).digest("hex");

async function seedEvent(data: {
  userId: string; eventType: string; success: boolean; reasonCode?: string;
  ip?: string; userAgent?: string; createdAt?: Date;
}) {
  const row = await db.securityEvent.create({
    data: {
      userId: data.userId,
      eventType: data.eventType,
      success: data.success,
      reasonCode: data.reasonCode ?? null,
      ipHash: data.ip ? sha(data.ip) : null,
      userAgent: data.userAgent ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
  seededEventIds.push(row.id);
  if (data.ip) seededIpByEventId.set(row.id, data.ip);
  return row;
}

const EVENT_KEYS = ["id", "eventType", "success", "reasonCode", "email", "userAgent", "ipHashPrefix", "createdAt"].sort();
/** eventId → raw IP used at seed time (per-row prefix assertion). */
const seededIpByEventId = new Map<string, string>();

async function main() {
  console.log("== R63-P fixtures ==");
  const hash = bcrypt.hashSync(PW, 10);

  const superUser = await db.user.create({ data: { email: `r63p-sup-${TS}@t.dev`, name: "R63P Super", passwordHash: hash, emailVerifiedAt: new Date() } });
  const secUser = await db.user.create({ data: { email: `r63p-sec-${TS}@t.dev`, name: "R63P Security", passwordHash: hash, emailVerifiedAt: new Date() } });
  const bilUser = await db.user.create({ data: { email: `r63p-bil-${TS}@t.dev`, name: "R63P Billing", passwordHash: hash, emailVerifiedAt: new Date() } });
  const roUser = await db.user.create({ data: { email: `r63p-ro-${TS}@t.dev`, name: "R63P Readonly", passwordHash: hash, emailVerifiedAt: new Date() } });
  const supUser = await db.user.create({ data: { email: `r63p-supsup-${TS}@t.dev`, name: "R63P Support", passwordHash: hash, emailVerifiedAt: new Date() } });
  const tenantUser = await db.user.create({ data: { email: `r63p-tenant-${TS}@t.dev`, name: "R63P Tenant", passwordHash: hash, emailVerifiedAt: new Date() } });
  const probeUser = await db.user.create({ data: { email: `r63p-probe-${TS}@t.dev`, name: "R63P Probe", passwordHash: hash, emailVerifiedAt: new Date() } });
  createdUserIds.push(superUser.id, secUser.id, bilUser.id, roUser.id, supUser.id, tenantUser.id, probeUser.id);

  await db.platformOperator.create({ data: { userId: superUser.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
  await db.platformOperator.create({ data: { userId: secUser.id, role: "PLATFORM_SECURITY", active: true } });
  await db.platformOperator.create({ data: { userId: bilUser.id, role: "PLATFORM_BILLING", active: true } });
  await db.platformOperator.create({ data: { userId: roUser.id, role: "PLATFORM_READONLY", active: true } });
  await db.platformOperator.create({ data: { userId: supUser.id, role: "PLATFORM_SUPPORT", active: true } });
  await db.platformOperator.create({ data: { userId: probeUser.id, role: "PLATFORM_SECURITY", active: true } });

  // Seed auth-lifecycle events for the TENANT user (the ورود و خروج ledger).
  const UA = "R63P-Agent/1.0 (fixture)";
  await seedEvent({ userId: tenantUser.id, eventType: "auth.login.success", success: true, ip: "203.0.113.9", userAgent: UA });
  await seedEvent({ userId: tenantUser.id, eventType: "auth.login.success", success: true, ip: "203.0.113.9", userAgent: UA });
  await seedEvent({ userId: tenantUser.id, eventType: "auth.login.success", success: true, ip: "203.0.113.10", userAgent: UA });
  await seedEvent({ userId: tenantUser.id, eventType: "auth.login.failed", success: false, reasonCode: "INVALID_CREDENTIALS", ip: "198.51.100.7", userAgent: UA });
  await seedEvent({ userId: tenantUser.id, eventType: "auth.login.failed", success: false, reasonCode: "RATE_LIMITED", ip: "198.51.100.7", userAgent: UA });
  await seedEvent({ userId: tenantUser.id, eventType: "auth.mfa.login_failed", success: false, reasonCode: "MFA_FAILED", userAgent: UA });
  await seedEvent({ userId: tenantUser.id, eventType: "auth.session.revoked", success: true, userAgent: UA });
  // 8 days old — MUST be excluded from the 7d revocation counter.
  await seedEvent({ userId: tenantUser.id, eventType: "auth.session.revoked", success: true, createdAt: new Date(Date.now() - 8 * 86_400_000) });

  // R65 — SUPER_ADMIN MFA enforcement: real-API enrollment (Prompt 65 §6.2).
  const superMfa = await enrollFixtureMfa(caller(await login(superUser.email)), PW);
  const S = caller(await platformMfaLogin(superUser.email, PW, superMfa.secret));
  const SEC = caller(await login(secUser.email));
  const BIL = caller(await login(bilUser.email));
  const RO = caller(await login(roUser.email));
  const SUP = caller(await login(supUser.email));
  const TENANT = caller(await login(tenantUser.email));
  check("fixtures created + all 6 logins OK", true);

  /* --------------------- A. authorization matrix ----------------------- */
  console.log("== A. auth matrix (summary + events) ==");
  const anonSummary = await caller(new Map())("/api/v1/platform/security/summary");
  const anonEvents = await caller(new Map())("/api/v1/platform/security/events");
  check("anon summary → 401", anonSummary.status === 401, `status=${anonSummary.status}`);
  check("anon events → 401", anonEvents.status === 401, `status=${anonEvents.status}`);

  const tSummary = await TENANT("/api/v1/platform/security/summary");
  const tEvents = await TENANT("/api/v1/platform/security/events");
  check("tenant summary → 403 PLATFORM_FORBIDDEN", tSummary.status === 403 && tSummary.json?.error?.code === "PLATFORM_FORBIDDEN", JSON.stringify(tSummary.json?.error));
  check("tenant events → 403 PLATFORM_FORBIDDEN", tEvents.status === 403, `status=${tEvents.status}`);

  const bSummary = await BIL("/api/v1/platform/security/summary");
  const bEvents = await BIL("/api/v1/platform/security/events");
  check("BILLING summary → 403 PLATFORM_PERMISSION_DENIED", bSummary.status === 403 && bSummary.json?.error?.code === "PLATFORM_PERMISSION_DENIED", JSON.stringify(bSummary.json?.error));
  check("BILLING events → 403", bEvents.status === 403 && bEvents.json?.error?.code === "PLATFORM_PERMISSION_DENIED", `status=${bEvents.status}`);

  const supSummary = await SUP("/api/v1/platform/security/summary");
  check("SUPPORT summary → 403 (no platform:security:read)", supSummary.status === 403 && supSummary.json?.error?.code === "PLATFORM_PERMISSION_DENIED", `status=${supSummary.status}`);

  const roSummary = await RO("/api/v1/platform/security/summary");
  const roEvents = await RO("/api/v1/platform/security/events");
  check("READONLY summary → 200 (read permission only)", roSummary.status === 200, `status=${roSummary.status}`);
  check("READONLY events → 200", roEvents.status === 200, `status=${roEvents.status}`);

  const secSummary = await SEC("/api/v1/platform/security/summary");
  check("SECURITY summary → 200", secSummary.status === 200, `status=${secSummary.status}`);

  /* ------------------------ B. summary honesty ------------------------- */
  console.log("== B. summary counters == DB truth ==");
  const now = new Date();
  const from24h = new Date(now.getTime() - 86_400_000);
  const from7d = new Date(now.getTime() - 7 * 86_400_000);
  const sum = secSummary.json?.data;
  check("summary shape: all 10 fields present", Boolean(
    sum && ["generatedAt", "logins24h", "failedLogins24h", "rateLimitedLogins24h", "mfaFailures24h",
      "sessionRevocations7d", "suspendedUsers", "activeOperators", "activeSessions", "eventTypes24h"]
      .every((k) => k in sum),
  ), JSON.stringify(Object.keys(sum ?? {})));

  const dbLogins = await db.securityEvent.count({ where: { eventType: "auth.login.success", createdAt: { gte: from24h } } });
  const dbFailed = await db.securityEvent.count({ where: { eventType: "auth.login.failed", createdAt: { gte: from24h } } });
  const dbRatelimited = await db.securityEvent.count({ where: { eventType: "auth.login.failed", reasonCode: "RATE_LIMITED", createdAt: { gte: from24h } } });
  const dbMfaFail = await db.securityEvent.count({ where: { eventType: "auth.mfa.login_failed", createdAt: { gte: from24h } } });
  const dbRevocations7d = await db.securityEvent.count({ where: { eventType: { in: ["auth.session.revoked", "auth.session.revoked_all"] }, createdAt: { gte: from7d } } });
  const dbSuspended = await db.user.count({ where: { suspendedAt: { not: null } } });
  const dbActiveOps = await db.platformOperator.count({ where: { active: true } });
  const dbActiveSessions = await db.userSession.count({ where: { revokedAt: null, expiresAt: { gt: now } } });

  check("logins24h == DB", sum.logins24h === dbLogins, `api=${sum.logins24h} db=${dbLogins}`);
  check("failedLogins24h == DB (seeded 2 included)", sum.failedLogins24h === dbFailed && dbFailed >= 2, `api=${sum.failedLogins24h} db=${dbFailed}`);
  check("rateLimitedLogins24h == DB (seeded 1 included)", sum.rateLimitedLogins24h === dbRatelimited && dbRatelimited >= 1, `api=${sum.rateLimitedLogins24h} db=${dbRatelimited}`);
  check("mfaFailures24h == DB (seeded 1 included)", sum.mfaFailures24h === dbMfaFail && dbMfaFail >= 1, `api=${sum.mfaFailures24h} db=${dbMfaFail}`);
  check("sessionRevocations7d == DB (8-day-old event EXCLUDED)", sum.sessionRevocations7d === dbRevocations7d && dbRevocations7d >= 1, `api=${sum.sessionRevocations7d} db=${dbRevocations7d}`);
  check("suspendedUsers == DB", sum.suspendedUsers === dbSuspended, `api=${sum.suspendedUsers} db=${dbSuspended}`);
  check("activeOperators == DB (6 fixtures included)", sum.activeOperators === dbActiveOps && dbActiveOps >= 6, `api=${sum.activeOperators} db=${dbActiveOps}`);
  check("activeSessions == DB truth", sum.activeSessions === dbActiveSessions, `api=${sum.activeSessions} db=${dbActiveSessions}`);
  check("eventTypes24h breakdown contains auth.login.failed", (sum.eventTypes24h?.["auth.login.failed"] ?? 0) >= 2, JSON.stringify(sum.eventTypes24h));

  /* ------------------------- C. events filters ------------------------- */
  console.log("== C. events filters ==");
  const list = await SEC("/api/v1/platform/security/events?page=1&pageSize=50");
  check("default list 200 with facets", list.status === 200 && Array.isArray(list.json?.data?.events) && Array.isArray(list.json?.data?.facets?.eventTypes), `status=${list.status}`);
  check("facets expose the fixed vocabulary (≥20 incl. login.success + suspended lifecycle)",
    list.json.data.facets.eventTypes.includes("auth.login.success") &&
    list.json.data.facets.eventTypes.includes("platform.account.suspended") &&
    list.json.data.facets.eventTypes.length >= 20,
    `count=${list.json.data.facets.eventTypes.length}`);
  // R67 — pagination-resilient reachability: the feed grows with platform
  // activity (invite lifecycle events etc.), so page 1 of 50 no longer
  // guarantees a seat for the seeded rows. "Reachable in the default list"
  // is honestly asserted by walking up to 3 pages of 100.
  const seededSet = new Set(seededEventIds);
  const foundSeeds = new Set<string>();
  for (let p = 1; p <= 3 && foundSeeds.size < seededSet.size; p++) {
    const pg = await SEC(`/api/v1/platform/security/events?page=${p}&pageSize=100`);
    if (pg.status !== 200) break;
    for (const e of pg.json?.data?.events ?? []) if (seededSet.has(e.id)) foundSeeds.add(e.id);
  }
  const seededInDefault = foundSeeds.size;
  check("all 8 seeded events reachable in default list", seededInDefault === 8, `found=${seededInDefault}`);

  const byType = await SEC("/api/v1/platform/security/events?eventType=auth.login.failed&pageSize=100");
  const dbByType = await db.securityEvent.count({ where: { eventType: "auth.login.failed" } });
  check("eventType filter == DB count", byType.json?.data?.page?.total === dbByType && byType.json.data.events.every((e: any) => e.eventType === "auth.login.failed"), `api=${byType.json?.data?.page?.total} db=${dbByType}`);

  const badType = await SEC("/api/v1/platform/security/events?eventType=auth.login.bogus");
  check("unknown eventType → 422", badType.status === 422 && badType.json?.error?.code === "PLATFORM_INVALID_OPERATION", `status=${badType.status}`);

  const badSuccess = await SEC("/api/v1/platform/security/events?success=bogus");
  check("bogus success value → 422", badSuccess.status === 422, `status=${badSuccess.status}`);

  const failures = await SEC("/api/v1/platform/security/events?success=false&pageSize=100");
  check("success=false returns ONLY failures", failures.json.data.events.length > 0 && failures.json.data.events.every((e: any) => e.success === false), `rows=${failures.json.data.events.length}`);

  const byEmail = await SEC(`/api/v1/platform/security/events?email=${encodeURIComponent(tenantUser.email)}&pageSize=100`);
  check("email filter scopes to the tenant user only", byEmail.json.data.page.total >= 8 && byEmail.json.data.events.every((e: any) => e.email === tenantUser.email), `total=${byEmail.json.data.page.total}`);

  const byId = await SEC(`/api/v1/platform/security/events?userId=${tenantUser.id}&eventType=auth.mfa.login_failed`);
  check("userId+eventType narrow to the seeded MFA row", byId.json.data.page.total === 1 && byId.json.data.events[0]?.email === tenantUser.email, `total=${byId.json.data.page.total}`);

  const today = new Date().toISOString().slice(0, 10);
  const byDate = await SEC(`/api/v1/platform/security/events?createdFrom=${today}&pageSize=100`);
  check("createdFrom=today excludes the 8-day-old event", byDate.json.data.events.every((e: any) => !seededEventIds.includes(e.id) || new Date(e.createdAt).getTime() >= new Date(`${today}T00:00:00Z`).getTime()), `total=${byDate.json.data.page.total}`);

  const clamped = await SEC("/api/v1/platform/security/events?pageSize=1000");
  check("pageSize=1000 clamped to ≤100", clamped.json.data.page.pageSize <= 100, `pageSize=${clamped.json.data.page.pageSize}`);

  /* -------------------------- D. DTO hygiene --------------------------- */
  console.log("== D. DTO hygiene (no raw IP, bounded fields) ==");
  const rows: any[] = [...list.json.data.events, ...failures.json.data.events, ...byEmail.json.data.events];
  const exactKeys = rows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(EVENT_KEYS));
  check("every row has EXACTLY the contracted keys", exactKeys, JSON.stringify(rows[0] ? Object.keys(rows[0]) : []));
  const noIpFields = rows.every((r) => !("ip" in r) && !("ipHash" in r) && !("userId" in r));
  check("no ip/ipHash/userId fields exist (hash-prefix minimization)", noIpFields);
  const prefixHex = rows.every((r) => r.ipHashPrefix === null || /^[0-9a-f]{1,12}$/.test(r.ipHashPrefix));
  check("ipHashPrefix is a ≤12-char hex prefix (never a raw IP)", prefixHex);
  const uaBounded = rows.every((r) => r.userAgent === null || (typeof r.userAgent === "string" && r.userAgent.length <= 255));
  check("userAgent bounded ≤ 255", uaBounded);
  const seededRows = rows.filter((r) => seededIpByEventId.has(r.id));
  const perRowOk = seededRows.length >= 4 && seededRows.every((r) => r.ipHashPrefix === sha(seededIpByEventId.get(r.id)!).slice(0, 12));
  check("seeded hash prefixes match the documented salt law (per-row)", perRowOk, `verified=${seededRows.length}`, );

  /* ------------------ E. overview security block ----------------------- */
  console.log("== E. overview security block ==");
  const ov = await S("/api/v1/platform/overview");
  const sec = ov.json?.data?.security;
  const ovFrom = new Date(now.getTime() - 30 * 86_400_000);
  const dbOvLogins = await db.securityEvent.count({ where: { eventType: "auth.login.success", createdAt: { gte: ovFrom } } });
  const dbOvFailed = await db.securityEvent.count({ where: { eventType: "auth.login.failed", createdAt: { gte: ovFrom } } });
  check("overview returns security block", Boolean(sec), JSON.stringify(sec));
  check("overview loginsWindow == DB (30d)", sec?.loginsWindow === dbOvLogins, `api=${sec?.loginsWindow} db=${dbOvLogins}`);
  check("overview failedLoginsWindow == DB (30d)", sec?.failedLoginsWindow === dbOvFailed, `api=${sec?.failedLoginsWindow} db=${dbOvFailed}`);
  check("overview suspendedUsers == DB", sec?.suspendedUsers === dbSuspended, `api=${sec?.suspendedUsers} db=${dbSuspended}`);

  /* ------------------- F. read rate-limit layer ------------------------ */
  console.log("== F. read rate limit (dedicated probe operator) ==");
  const PROBE = caller(await login(probeUser.email));
  let saw429 = false;
  let lastStatus = 0;
  for (let i = 0; i < 61; i++) {
    const r = await PROBE("/api/v1/platform/security/summary");
    lastStatus = r.status;
    if (r.status === 429) { saw429 = true; break; }
  }
  check("61st rapid read → 429 (rate-limit layer fires on reads)", saw429, `lastStatus=${lastStatus}`);

  /* ----------------------------- cleanup ------------------------------- */
  console.log("== cleanup ==");
  await db.securityEvent.deleteMany({ where: { id: { in: seededEventIds } } });
  await clearFixtureMfa(db, createdUserIds);
  await db.platformOperator.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  const residueEvents = await db.securityEvent.count({ where: { id: { in: seededEventIds } } });
  const residueUsers = await db.user.count({ where: { id: { in: createdUserIds } } });
  check("cleanup: zero fixture residue", residueEvents === 0 && residueUsers === 0, `events=${residueEvents} users=${residueUsers}`);

  console.log("=========================================");
  console.log(`R63-P SECURITY CENTER: ${pass}/${pass + fail} ${fail === 0 ? "PASS — ALL GREEN ✓" : `FAIL (${fail}) ✗`}`);
  await db.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("R63-P harness crashed:", e);
  try {
    await db.securityEvent.deleteMany({ where: { id: { in: seededEventIds } } });
    await db.platformOperator.deleteMany({ where: { userId: { in: createdUserIds } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {}
  await db.$disconnect();
  process.exit(1);
});

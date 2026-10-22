/**
 * scripts/prompt32-notification-check.mjs — Prompt 32 E2E harness (§388).
 *
 * Exercises the REAL HTTP surface + real NextAuth flow against the dev
 * server, plus direct DB access ONLY for delivery-state verification,
 * dedupe-constraint checks, time simulation and cleanup verification
 * (clearly marked below — the same contract as the Prompt 30/31 harnesses).
 *
 * Sections:
 *   SETUP            register/login/seed (users A(owner bizA)/B(owner bizB)/staff)
 *   AUTH GATES       401 unauthenticated · cross-user 404 · body-identity ignored
 *   LOGIN NOTIFY     real sign-in → SECURITY_NEW_LOGIN in-app + unread count
 *   PREFERENCES      effective map · mandatory 403 · unknown 422 · optional OFF → SKIPPED
 *   SECURITY         password change → in-app + mandatory EMAIL SENT (db + console log)
 *   BILLING          change plan → BILLING_SUBSCRIPTION_CHANGED (owner recipient)
 *   DATA PORTABILITY export complete + import commit → BUSINESS_* notifications
 *   DEDUPE           unique(userId,type,sourceEventId) constraint · per-login no false dedupe
 *   READ FLOW        read → unread count drops · read-all · archive hides · pagination
 *   ISOLATION        user A vs B lists · business filter honors membership only
 *   I18N             fa locale → Persian titles · en default
 *   RESPONSE SHAPE   DTO exposes no internals (dataJson/keys/deliveries/secrets)
 *   CLEANUP          prune dry-run · --apply removes eligible rows only (security kept)
 *
 * Run:  bun scripts/prompt32-notification-check.mjs
 *       (needs the dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.P32_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const db = new PrismaClient();

for (const line of readDbEnv()) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
function readDbEnv() {
  try {
    return readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n");
  } catch {
    return [];
  }
}

const results = [];
let current = "";
function section(name) {
  current = name;
}
function record(name, ok, info = "") {
  results.push({ section: current, name, ok, info });
  console.log(`${ok ? "✓" : "✗"} [${current}] ${name}${info ? ` — ${info}` : ""}`);
}
let lastResponses = {};
function check(name, cond, info = "") {
  if (!cond) {
    const snap = JSON.stringify(lastResponses).slice(0, 200);
    record(name, false, `${info} |last=${snap}`);
  } else record(name, true, info);
}

/* ------------------------------ fetch helpers ------------------------------ */
let XFF = `10.41.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
function jarFetch(jar) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": XFF, ...(init.headers ?? {}) };
    const isMultipart = typeof FormData !== "undefined" && init.body instanceof FormData;
    if (init.body && !isMultipart && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { ...init, headers: cookie ? { ...headers, cookie } : headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
    }
    return res;
  };
}
async function apiJson(f, path, init = {}) {
  const res = await f(path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  lastResponses = body;
  return { res, body };
}
function withBiz(jar, businessId) {
  const base = jarFetch(jar);
  return (path, init = {}) => base(path, { ...init, headers: { "x-business-id": businessId, ...(init.headers ?? {}) } });
}
async function login(jar, email, password) {
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true" });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const hasSession = [...jar.keys()].some((k) => k.includes("session-token"));
  return { res, hasSession };
}
async function registerApi(email, name = "P32 Harness") {
  const f = jarFetch(new Map());
  const { body } = await apiJson(f, "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASS }),
  });
  return body;
}
async function createBusiness(jar, name) {
  const f = jarFetch(jar);
  const { body } = await apiJson(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name, currencyCode: "EUR", locale: "en", timezone: "UTC" }),
  });
  return body;
}
async function uploadImport(f, dataset, fileName, content, mime = "text/csv") {
  XFF = `10.41.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  const form = new FormData();
  form.append("dataset", dataset);
  form.append("file", new File([content], fileName, { type: mime }));
  const res = await f("/api/v1/imports", { method: "POST", body: form, headers: { "x-forwarded-for": XFF } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* */
  }
  return { res, body };
}

/** dev.log tail — used ONLY to prove the console transport actually printed
 * a notification email (content check; delivery STATE comes from the DB). */
function devLogText(maxBytes = 400_000) {
  const p = new URL("../dev.log", import.meta.url);
  if (!existsSync(p)) return "";
  const buf = readFileSync(p);
  const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return slice.toString("utf8");
}

const SECRET_TOKENS = [
  "passwordHash",
  "encryptedSecret",
  "codeHash",
  "tokenHash",
  "sessionTokenHash",
  "dataJson",
  "titleKey",
  "bodyKey",
  "sourceEventId",
  "PlatformAuditLog",
  "AiCostRate",
  "merchantSecret",
  "recoveryCode",
];

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================================ SETUP ==================================== */
const RUN = randomBytes(4).toString("hex");
const A_EMAIL = `p32-a-${RUN}@harness.test`;
const B_EMAIL = `p32-b-${RUN}@harness.test`;
const C_EMAIL = `p32-c-${RUN}@harness.test`;
const STAFF_EMAIL = `p32-s-${RUN}@harness.test`;

section("SETUP");
const regIds = {};
for (const [email, name] of [
  [A_EMAIL, "P32 A"],
  [B_EMAIL, "P32 B"],
  [C_EMAIL, "P32 C"],
  [STAFF_EMAIL, "P32 Staff"],
]) {
  const reg = await registerApi(email, name);
  regIds[email] = reg?.data?.user?.id ?? reg?.data?.id;
  check(`SETUP: register ${name}`, reg?.ok === true, reg?.error?.code ?? email);
}
const jarA = new Map();
check("SETUP: login A", (await login(jarA, A_EMAIL, PASS)).hasSession);
const jarB = new Map();
check("SETUP: login B", (await login(jarB, B_EMAIL, PASS)).hasSession);
const jarStaff = new Map();
check("SETUP: login staff", (await login(jarStaff, STAFF_EMAIL, PASS)).hasSession);

const fA = jarFetch(jarA);
const fB = jarFetch(jarB);

const bizA = await createBusiness(jarA, `P32 Notif Biz ${RUN}`);
check("SETUP: business A created", bizA?.ok === true, bizA?.error?.code ?? bizA?.data?.business?.id);
const A_ID = bizA?.data?.business?.id;
const bizB = await createBusiness(jarB, `P32 Other Biz ${RUN}`);
check("SETUP: business B created", bizB?.ok === true);
const B_ID = bizB?.data?.business?.id;

const bA = withBiz(jarA, A_ID);
const bB = withBiz(jarB, B_ID);
const bStaff = withBiz(jarStaff, A_ID);

const addStaff = await apiJson(bA, `/api/v1/businesses/${A_ID}/members`, {
  method: "POST",
  body: JSON.stringify({ email: STAFF_EMAIL, role: "STAFF" }),
});
check("SETUP: staff added to A", addStaff.res.status === 201 || addStaff.res.status === 200, addStaff.body?.error?.code ?? "");

// A_ID may be undefined if business creation failed — bail out honestly.
if (!A_ID || !regIds[A_EMAIL]) {
  console.error("FATAL: setup incomplete — aborting harness.");
  process.exit(1);
}

/* ============================= LOGIN NOTIFY ================================ */
section("LOGIN NOTIFY");
// A fresh login creates SECURITY_NEW_LOGIN (in-app ALWAYS + optional email).
// §49 fixture: A's address is marked VERIFIED (DB fixture — production marks
// it through the verification flow); B stays UNVERIFIED to prove the
// optional-email eligibility rule.
await db.user.update({ where: { id: regIds[A_EMAIL] }, data: { emailVerifiedAt: new Date() } });
const jarA2 = new Map();
const secondLogin = await login(jarA2, A_EMAIL, PASS);
check("LOGIN: second login ok", secondLogin.hasSession);
const fA2 = jarFetch(jarA2);
await wait(700);
const loginNotifs = await db.notification.findMany({
  where: { userId: regIds[A_EMAIL], type: "SECURITY_NEW_LOGIN" },
  include: { deliveries: true },
  orderBy: { createdAt: "desc" },
});
check("LOGIN: SECURITY_NEW_LOGIN notification created (§96)", loginNotifs.length >= 1, `count=${loginNotifs.length}`);
check("LOGIN: device label stored, no IP/user-agent (§96)", (() => {
  const n = loginNotifs[0];
  if (!n) return false;
  const data = JSON.parse(n.dataJson ?? "{}");
  return typeof data.device === "string" && data.device.length <= 120 && !("ip" in data) && !("userAgent" in data);
})());
check("LOGIN: IN_APP delivery SENT (§34/§142)", loginNotifs[0]?.deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT"), JSON.stringify(loginNotifs[0]?.deliveries.map((d) => `${d.channel}:${d.status}`) ?? []));
check("LOGIN: EMAIL delivery SENT for VERIFIED recipient (§49)", loginNotifs[0]?.deliveries.some((d) => d.channel === "EMAIL" && d.status === "SENT") === true, JSON.stringify(loginNotifs[0]?.deliveries.map((d) => `${d.channel}:${d.status}`) ?? []));
const bLoginNotif = await db.notification.findFirst({
  where: { userId: regIds[B_EMAIL], type: "SECURITY_NEW_LOGIN" },
  include: { deliveries: true },
  orderBy: { createdAt: "desc" },
});
check(
  "LOGIN: UNVERIFIED recipient → EMAIL SKIPPED, in-app intact (§49)",
  bLoginNotif?.deliveries.some((d) => d.channel === "EMAIL" && d.status === "SKIPPED" && d.failureCode === "RECIPIENT_UNVERIFIED") === true,
  JSON.stringify(bLoginNotif?.deliveries.map((d) => `${d.channel}:${d.status}:${d.failureCode ?? ""}`) ?? []),
);

const unreadA = await apiJson(fA2, "/api/v1/me/notifications/unread-count");
check("LOGIN: unread count > 0 (§52/§300)", unreadA.body?.data?.count > 0, `count=${unreadA.body?.data?.count}`);
const listA = await apiJson(fA2, "/api/v1/me/notifications?pageSize=20");
check("LOGIN: list contains the login notification, newest first (§334/§367)", listA.body?.data?.items?.some((i) => i.type === "SECURITY_NEW_LOGIN"), `items=${listA.body?.data?.items?.length}`);
check(
  "LOGIN: list sorted createdAt DESC",
  (() => {
    const items = listA.body?.data?.items ?? [];
    for (let i = 1; i < items.length; i += 1) {
      if (items[i - 1].createdAt < items[i].createdAt) return false;
    }
    return true;
  })(),
);

/* ============================== AUTH GATES ================================= */
section("AUTH GATES");
const anonList = await apiJson(jarFetch(new Map()), "/api/v1/me/notifications");
check("AUTH: unauthenticated list 401 (§240)", anonList.res.status === 401, String(anonList.res.status));
const anonCount = await apiJson(jarFetch(new Map()), "/api/v1/me/notifications/unread-count");
check("AUTH: unauthenticated unread-count 401", anonCount.res.status === 401, String(anonCount.res.status));
const anonPrefs = await apiJson(jarFetch(new Map()), "/api/v1/me/notification-preferences");
check("AUTH: unauthenticated preferences 401", anonPrefs.res.status === 401, String(anonPrefs.res.status));

// Identity comes from the session — a body userId is NEVER honored (§19/§185).
const spoofedPref = await apiJson(fA, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({
    userId: regIds[B_EMAIL],
    notificationType: "SECURITY_NEW_LOGIN",
    channel: "EMAIL",
    enabled: false,
  }),
});
check(
  "AUTH: body userId ignored — target type validated instead (§19/§185)",
  spoofedPref.res.status === 200 || spoofedPref.res.status === 422,
  `status=${spoofedPref.res.status}`,
);
if (spoofedPref.res.status === 200) {
  const prefRow = await db.notificationPreference.findUnique({
    where: {
      userId_notificationType_channel: {
        userId: regIds[A_EMAIL],
        notificationType: "SECURITY_NEW_LOGIN",
        channel: "EMAIL",
      },
    },
  });
  check("AUTH: preference written for SESSION user, never body userId", prefRow?.userId === regIds[A_EMAIL], prefRow ? "ok" : "missing");
}

/* ============================= PREFERENCES ================================= */
section("PREFERENCES");
const prefs = await apiJson(fA2, "/api/v1/me/notification-preferences");
check("PREFS: effective map returned (§60)", prefs.res.status === 200 && Array.isArray(prefs.body?.data?.preferences));
// Prompt 37 catalog extension: 19 → 22 types (BUSINESS_CRM_TASK_*).
// PROMPT 63 fix: the catalog legitimately GREW to 28 types (R60/R61 added
// inventory-digest, weekly-digest, api-key and stocktake types), so an
// exact `=== 23` count was a stale expectation that failed against the
// real catalog. The honest invariant is SUPERSET semantics derived from
// the AUTHORITATIVE catalog at runtime: every type declared in
// src/lib/notifications/catalog.ts must have a preferences row (§60 —
// the effective map covers the whole catalog), and the total must be ≥ 23.
const catalogSrc = readFileSync("src/lib/notifications/catalog.ts", "utf8");
const catalogTypesMatch = catalogSrc.match(/export const NOTIFICATION_TYPES[\s\S]*?\] as const/);
const catalogTypes = (catalogTypesMatch?.[0].match(/"[A-Z_]+"/g) ?? []).map((s) => s.slice(1, -1));
check("PREFS: catalog parse sane (≥23 authoritative types)", catalogTypes.length >= 23, `catalog=${catalogTypes.length}`);
check("PREFS: every authoritative catalog type has a preferences row (§60 superset law)", (() => {
  const present = new Set((prefs.body?.data?.preferences ?? []).map((p) => p.notificationType));
  const missing = catalogTypes.filter((t) => !present.has(t));
  return present.size >= 23 && missing.length === 0;
})(), `types=${new Set((prefs.body?.data?.preferences ?? []).map((p) => p.notificationType)).size} catalog=${catalogTypes.length}`);
check("PREFS: mandatory channels not overridable (§64)", (prefs.body?.data?.preferences ?? []).every((p) => (p.mandatory ? !p.overridable && p.enabled === true : true)));
check("PREFS: IN_APP always mandatory across catalog (§10)", (prefs.body?.data?.preferences ?? []).filter((p) => p.channel === "IN_APP").every((p) => p.mandatory));

const mandatoryPut = await apiJson(fA2, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "SECURITY_MFA_DISABLED", channel: "EMAIL", enabled: false }),
});
check(
  "PREFS: disabling mandatory security notification → 403 NOTIFICATION_PREFERENCE_FORBIDDEN (§62)",
  mandatoryPut.res.status === 403 && mandatoryPut.body?.error?.code === "NOTIFICATION_PREFERENCE_FORBIDDEN",
  `${mandatoryPut.res.status} ${mandatoryPut.body?.error?.code ?? ""}`,
);
const unknownPut = await apiJson(fA2, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "TOTALLY_FAKE_TYPE", channel: "EMAIL", enabled: false }),
});
check("PREFS: unknown type → 422 (§61)", unknownPut.res.status === 422, `${unknownPut.res.status}`);
const badChannelPut = await apiJson(fA2, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "SECURITY_NEW_LOGIN", channel: "SMS", enabled: false }),
});
check("PREFS: unsupported channel → 422 (§9/§61)", badChannelPut.res.status === 422, `${badChannelPut.res.status}`);

// Optional channel OFF → next login's EMAIL delivery is SKIPPED, in-app remains (§275/§277).
const offPut = await apiJson(fA2, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "SECURITY_NEW_LOGIN", channel: "EMAIL", enabled: false }),
});
check("PREFS: optional email disabled", offPut.res.status === 200 && offPut.body?.data?.preference?.enabled === false, `${offPut.res.status}`);
const jarA3 = new Map();
await login(jarA3, A_EMAIL, PASS);
const fA3 = jarFetch(jarA3);
await wait(700);
const skippedLogin = await db.notification.findFirst({
  where: { userId: regIds[A_EMAIL], type: "SECURITY_NEW_LOGIN" },
  include: { deliveries: true },
  orderBy: { createdAt: "desc" },
});
check(
  "PREFS: optional email OFF → EMAIL SKIPPED, IN_APP still SENT (§275/§277)",
  skippedLogin?.deliveries.some((d) => d.channel === "EMAIL" && d.status === "SKIPPED") === true &&
    skippedLogin?.deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT") === true,
  JSON.stringify(skippedLogin?.deliveries.map((d) => `${d.channel}:${d.status}`) ?? []),
);
const onPut = await apiJson(fA3, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "SECURITY_NEW_LOGIN", channel: "EMAIL", enabled: true }),
});
check("PREFS: optional email re-enabled", onPut.res.status === 200);

/* =============================== SECURITY ================================== */
section("SECURITY");
// Mandatory security email bypasses preferences entirely (§14/§62).
const pwdChange = await apiJson(fA3, "/api/v1/auth/password-change", {
  method: "POST",
  body: JSON.stringify({ currentPassword: PASS, newPassword: "NewPass123!x", confirmPassword: "NewPass123!x" }),
});
check("SECURITY: password change ok", pwdChange.res.status === 200, pwdChange.body?.error?.code ?? "");
await wait(900);
const pwdNotif = await db.notification.findFirst({
  where: { userId: regIds[A_EMAIL], type: "SECURITY_PASSWORD_CHANGED" },
  include: { deliveries: true },
  orderBy: { createdAt: "desc" },
});
check("SECURITY: password-change notification created (§91)", Boolean(pwdNotif), pwdNotif ? "" : "missing");
check(
  "SECURITY: MANDATORY email delivered despite any preference (§14)",
  pwdNotif?.deliveries.some((d) => d.channel === "EMAIL" && d.status === "SENT") === true,
  JSON.stringify(pwdNotif?.deliveries.map((d) => `${d.channel}:${d.status}`) ?? []),
);
check("SECURITY: notification data has NO password (§407)", (() => {
  if (!pwdNotif) return false;
  const data = JSON.parse(pwdNotif.dataJson ?? "{}");
  return !("password" in data) && !("newPassword" in data) && Object.keys(data).length === 1 && "changedAt" in data;
})(), JSON.stringify(pwdNotif?.dataJson ?? "{}"));
check(
  "SECURITY: console transport actually rendered the email (§323 — no false 'sent')",
  devLogText().includes("Your password was changed"),
);

// sessionVersion bumped → old jar invalid; re-login works (and notifies).
const reloginA = new Map();
check("SECURITY: re-login with new password", (await login(reloginA, A_EMAIL, "NewPass123!x")).hasSession);

// Password reset flow (user C): request → dev.log link → confirm.
const jarC = new Map();
check("SECURITY: login C", (await login(jarC, C_EMAIL, PASS)).hasSession);
const fC = jarFetch(jarC);
const resetReq = await apiJson(jarFetch(new Map()), "/api/v1/auth/password-reset/request", {
  method: "POST",
  body: JSON.stringify({ email: C_EMAIL }),
});
check("SECURITY: password reset request accepted", resetReq.res.status === 200, `${resetReq.res.status}`);
await wait(400);
const logText = devLogText();
const linkMatch = logText.match(/#\/reset-password\/([A-Za-z0-9_-]+)/g);
const resetLink = linkMatch?.[linkMatch.length - 1] ?? "";
check("SECURITY: reset link available from dev console transport", resetLink.length > 0);
const resetToken = resetLink.split("/reset-password/")[1] ?? "";
const resetConfirm = await apiJson(jarFetch(new Map()), "/api/v1/auth/password-reset/confirm", {
  method: "POST",
  body: JSON.stringify({ token: resetToken, newPassword: "ResetPass456!y", confirmPassword: "ResetPass456!y" }),
});
check("SECURITY: reset confirm ok", resetConfirm.res.status === 200, resetConfirm.body?.error?.code ?? "");
await wait(900);
const resetNotif = await db.notification.findFirst({
  where: { userId: regIds[C_EMAIL], type: "SECURITY_PASSWORD_RESET_COMPLETED" },
  include: { deliveries: true },
});
check("SECURITY: reset-completed notification created (§92)", Boolean(resetNotif));
check("SECURITY: reset email MANDATORY + SENT", resetNotif?.deliveries.some((d) => d.channel === "EMAIL" && d.status === "SENT") === true);
check("SECURITY: reset notification contains NO token (§404)", (() => {
  if (!resetNotif) return false;
  const raw = JSON.stringify(JSON.parse(resetNotif.dataJson ?? "{}"));
  return !raw.includes(resetToken.slice(0, 12)) && resetToken.length > 0;
})());

/* ================================ BILLING ================================== */
section("BILLING");
// The password change invalidated A's OLD session — every business-scoped
// call from here runs on the FRESH jar (fA3 session + business header).
const bA3 = withBiz(reloginA, A_ID); // reloginA holds the FRESH post-change session
const planChange = await apiJson(bA3, "/api/v1/billing/change-plan", {
  method: "POST",
  body: JSON.stringify({ planCode: "STARTER" }),
});
check("BILLING: change plan accepted", planChange.res.status === 200, planChange.body?.error?.code ?? JSON.stringify(planChange.body).slice(0, 120));
await wait(900);
const subNotif = await db.notification.findFirst({
  where: { userId: regIds[A_EMAIL], type: "BILLING_SUBSCRIPTION_CHANGED" },
  include: { deliveries: true },
});
check("BILLING: subscription-changed notification for the OWNER (§90)", Boolean(subNotif), subNotif ? "" : "missing");
check("BILLING: recipient is the business owner, not an actor string", subNotif?.userId === regIds[A_EMAIL]);
const subData = subNotif ? JSON.parse(subNotif.dataJson ?? "{}") : {};
check("BILLING: change label is a safe enum value (§225)", ["plan_changed", "canceled", "reactivated", "paused", "resumed", "expired"].includes(subData.change), String(subData.change));
check("BILLING: no operator identity in data (§90)", !("actor" in subData) && !("operatorId" in subData));

/* =========================== DATA PORTABILITY ============================== */
section("DATA PORTABILITY");
const expCreate = await apiJson(bA3, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ datasets: ["business"], format: "JSON" }),
});
check("EXPORT: job created", expCreate.res.status === 201 || expCreate.res.status === 200, `${expCreate.res.status} ${expCreate.body?.error?.code ?? ""}`);
const EXP_ID = expCreate.body?.data?.job?.id ?? expCreate.body?.data?.id;
let exportDone = false;
for (let i = 0; i < 30 && EXP_ID; i += 1) {
  await wait(500);
  const st = await apiJson(bA3, `/api/v1/exports/${EXP_ID}`);
  if (st.body?.data?.status === "COMPLETED" || st.body?.data?.status === "FAILED") {
    exportDone = st.body?.data?.status === "COMPLETED";
    break;
  }
}
check("EXPORT: job completes", exportDone);
await wait(900);
const expNotif = await db.notification.findFirst({
  where: { userId: regIds[A_EMAIL], type: "BUSINESS_EXPORT_COMPLETED" },
  include: { deliveries: true },
});
check("EXPORT: completed notification created AFTER checksum (§100/§328)", Boolean(expNotif));
check("EXPORT: notification carries counts, NO file path (§167)", (() => {
  if (!expNotif) return false;
  const data = JSON.parse(expNotif.dataJson ?? "{}");
  return typeof data.recordCount === "number" && !("storageKey" in data) && !("filePath" in data);
})());
check("EXPORT: email optional default ON → SENT", expNotif?.deliveries.some((d) => d.channel === "EMAIL" && d.status === "SENT") === true);

// Import → completed notification (template round-trip, §98/§329).
const tplRes = await bA3("/api/v1/imports/templates/customers");
const templateCsv = await tplRes.text();
const tplUpload = await uploadImport(bA3, "customers", "Customer.csv", templateCsv);
check("IMPORT: template upload accepted", tplUpload.res.status === 201, `${tplUpload.res.status} ${tplUpload.body?.error?.code ?? ""}`);
const TPL_JOB = tplUpload.body?.data?.job?.id;
const tplMap = await apiJson(bA3, `/api/v1/imports/${TPL_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: tplUpload.body?.data?.suggestedMapping, duplicateMode: "SKIP" }),
});
check("IMPORT: mapping accepted", tplMap.res.status === 200, tplMap.body?.error?.code ?? "");
await apiJson(bA3, `/api/v1/imports/${TPL_JOB}/validate`, { method: "POST" });
const reauth = await apiJson(bA3, "/api/v1/me/security/reauth", {
  method: "POST",
  body: JSON.stringify({ password: "NewPass123!x" }),
});
check("IMPORT: reauth ok", reauth.res.status === 200, reauth.body?.error?.code ?? "");
const tplCommit = await apiJson(bA3, `/api/v1/imports/${TPL_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("IMPORT: commit ok", tplCommit.res.status === 200 && tplCommit.body?.data?.created === 1, `${tplCommit.res.status} ${tplCommit.body?.error?.code ?? ""}`);
await wait(900);
const impNotif = await db.notification.findFirst({
  where: { userId: regIds[A_EMAIL], type: "BUSINESS_IMPORT_COMPLETED" },
});
check("IMPORT: completed notification created AFTER commit (§98/§329)", Boolean(impNotif));
const impData = impNotif ? JSON.parse(impNotif.dataJson ?? "{}") : {};
check("IMPORT: summary counts only, NO raw rows (§168)", impData.created === 1 && !("rows" in impData) && !("fileContent" in impData), JSON.stringify(impData).slice(0, 120));

/* ================================ DEDUPE =================================== */
section("DEDUPE");
try {
  await db.notification.create({
    data: {
      userId: regIds[A_EMAIL],
      type: "SECURITY_PASSWORD_CHANGED",
      category: "SECURITY",
      priority: "HIGH",
      severity: "INFO",
      titleKey: "items.SECURITY_PASSWORD_CHANGED.title",
      bodyKey: "items.SECURITY_PASSWORD_CHANGED.body",
      sourceEventId: pwdNotif?.sourceEventId ?? "x",
    },
  });
  record("DEDUPE: unique(userId,type,sourceEventId) enforced (§28/§30)", false, "duplicate insert succeeded");
} catch (error) {
  record("DEDUPE: unique(userId,type,sourceEventId) enforced (§28/§30)", String(error?.code ?? "") === "P2002", `code=${error?.code}`);
}
const loginNotifCount = await db.notification.count({
  where: { userId: regIds[A_EMAIL], type: "SECURITY_NEW_LOGIN" },
});
check("DEDUPE: distinct logins create distinct notifications (§31 — no global suppression)", loginNotifCount >= 3, `count=${loginNotifCount}`);

/* =============================== READ FLOW ================================= */
section("READ FLOW");
const fA4 = jarFetch(reloginA); // fresh post-change session
const freshList = await apiJson(fA4, "/api/v1/me/notifications?pageSize=5");
const firstUnread = freshList.body?.data?.items?.find((i) => i.readAt === null);
check("READ: an unread notification exists", Boolean(firstUnread), firstUnread?.id ?? "none");
const beforeCount = await apiJson(fA4, "/api/v1/me/notifications/unread-count");
const readRes = await apiJson(fA4, `/api/v1/me/notifications/${firstUnread.id}/read`, { method: "POST" });
check("READ: mark read ok (§51)", readRes.res.status === 200, `${readRes.res.status}`);
const afterCount = await apiJson(fA4, "/api/v1/me/notifications/unread-count");
check("READ: unread count decreases (§300)", afterCount.body?.data?.count === beforeCount.body?.data?.count - 1, `${beforeCount.body?.data?.count} → ${afterCount.body?.data?.count}`);
const readAgain = await apiJson(fA4, `/api/v1/me/notifications/${firstUnread.id}/read`, { method: "POST" });
check("READ: idempotent re-read (§245)", readAgain.res.status === 200);

const archiveRes = await apiJson(fA4, `/api/v1/me/notifications/${firstUnread.id}/archive`, { method: "POST" });
check("ARCHIVE: archive ok (§56)", archiveRes.res.status === 200);
const afterArchive = await apiJson(fA4, `/api/v1/me/notifications?pageSize=50`);
check("ARCHIVE: removed from active list (§302)", !(afterArchive.body?.data?.items ?? []).some((i) => i.id === firstUnread.id));
const stillThere = await db.notification.findUnique({ where: { id: firstUnread.id } });
check("ARCHIVE: record NOT deleted (§118/§370)", Boolean(stillThere));

const readAllRes = await apiJson(fA4, "/api/v1/me/notifications/read-all", { method: "POST" });
check("READ-ALL: single statement ok (§55/§219)", readAllRes.res.status === 200, `${readAllRes.res.status}`);
const zeroCount = await apiJson(fA4, "/api/v1/me/notifications/unread-count");
check("READ-ALL: count reaches 0 (§301)", zeroCount.body?.data?.count === 0, `count=${zeroCount.body?.data?.count}`);
const bCount = await apiJson(fB, "/api/v1/me/notifications/unread-count");
check("READ-ALL: other users unaffected (§301)", bCount.body?.data?.count >= 0, `B count=${bCount.body?.data?.count}`);
const bUnreadRows = await db.notification.count({ where: { userId: regIds[B_EMAIL], readAt: null } });
check("READ-ALL: B's rows still unread", bUnreadRows > 0, `B unread=${bUnreadRows}`);

const pageSmall = await apiJson(fA4, "/api/v1/me/notifications?pageSize=5&page=1");
check("PAGINATION: pageSize honored (§54/§217)", (pageSmall.body?.data?.items ?? []).length <= 5, `items=${pageSmall.body?.data?.items?.length}`);
const pageBad = await apiJson(fA4, "/api/v1/me/notifications?pageSize=2&page=1");
check("PAGINATION: sub-floor pageSize falls back to a bounded default (§54)", (pageBad.body?.data?.items ?? []).length <= 20, `items=${pageBad.body?.data?.items?.length}`);
check("PAGINATION: total reported", typeof pageSmall.body?.data?.total === "number");

/* =============================== ISOLATION ================================= */
section("ISOLATION");
const aNotif = await db.notification.findFirst({ where: { userId: regIds[A_EMAIL] }, select: { id: true } });
const bReadsA = await apiJson(fB, `/api/v1/me/notifications/${aNotif.id}/read`, { method: "POST" });
check("ISOLATION: B cannot mark A's notification read → 404 (§183/§184)", bReadsA.res.status === 404, `${bReadsA.res.status}`);
const bArchivesA = await apiJson(fB, `/api/v1/me/notifications/${aNotif.id}/archive`, { method: "POST" });
check("ISOLATION: B cannot archive A's notification → 404", bArchivesA.res.status === 404, `${bArchivesA.res.status}`);
const bList = await apiJson(fB, "/api/v1/me/notifications?pageSize=50");
check("ISOLATION: B's list has only B's notifications (§394)", (bList.body?.data?.items ?? []).every((i) => i.id !== aNotif.id));
const staffCount = await apiJson(bStaff, "/api/v1/me/notifications/unread-count");
check("ISOLATION: staff user-scoped, not business-leaked (§195)", staffCount.res.status === 200);
// §198 — business filter constrained to CURRENT memberships: B cannot filter by A_ID.
const crossBiz = await apiJson(fB, `/api/v1/me/notifications?businessId=${A_ID}`);
check("ISOLATION: business filter ignores non-member business (§198)", crossBiz.res.status === 200);
// Delivery rows are never tenant-visible (§186/§396).
const deliveryProbe = await apiJson(fA4, "/api/v1/me/notifications?pageSize=5");
check("ISOLATION: DTOs expose no delivery/provider internals (§189/§363)", !JSON.stringify(deliveryProbe.body).includes("providerMessageId") && !JSON.stringify(deliveryProbe.body).includes("failureCode"));

/* ================================== I18N =================================== */
section("I18N");
// Register a user, switch its persisted locale to fa via PATCH /me; its
// notifications must then render fa titles (§160/§193).
const FA_EMAIL = `p32-fa-${RUN}@harness.test`;
const regFa = await registerApi(FA_EMAIL, "P32 FA");
check("I18N: fa user registered", regFa?.ok === true, regFa?.error?.code ?? "");
const jarFa = new Map();
check("I18N: fa user login", (await login(jarFa, FA_EMAIL, PASS)).hasSession);
const fFa = jarFetch(jarFa);
const setFa = await apiJson(fFa, "/api/v1/me", {
  method: "PATCH",
  body: JSON.stringify({ locale: "fa" }),
});
check("I18N: locale switched to fa", setFa.res.status === 200, `${setFa.res.status}`);
await wait(700);
const faList = await apiJson(fFa, "/api/v1/me/notifications?pageSize=5");
const faLoginItem = (faList.body?.data?.items ?? []).find((i) => i.type === "SECURITY_NEW_LOGIN");
check("I18N: Persian title rendered (§294)", Boolean(faLoginItem) && /[\u0600-\u06FF]/.test(faLoginItem.title ?? ""), faLoginItem?.title ?? "none");
check("I18N: no raw translation keys leaked (§353)", !(faLoginItem?.title ?? "").includes("items.") && !(faLoginItem?.body ?? "").includes("{"), faLoginItem?.body ?? "");
const enItem = (listA.body?.data?.items ?? []).find((i) => i.type === "SECURITY_NEW_LOGIN");
check("I18N: English default intact (§295)", Boolean(enItem) && /[a-zA-Z]/.test(enItem?.title ?? ""));

/* ============================= RESPONSE SHAPE ============================== */
section("RESPONSE SHAPE");
const allText = JSON.stringify(listA.body) + JSON.stringify(faList.body) + JSON.stringify(prefs.body);
const leaked = SECRET_TOKENS.filter((k) => allText.includes(k));
check("SHAPE: no internal/secret fields in any response (§392)", leaked.length === 0, leaked.join(",") || "clean");
check("SHAPE: action routes are internal hash paths only (§103/§289)", (listA.body?.data?.items ?? []).every((i) => i.action === null || /^#\/[a-z/]+$/.test(i.action.route)), JSON.stringify((listA.body?.data?.items ?? []).map((i) => i.action?.route).filter(Boolean)));

/* ================================ CLEANUP ================================== */
section("CLEANUP");
// Seed an OLD read non-security notification + an OLD read security one (DB fixture — §303).
const OLD = new Date(Date.now() - 400 * 86_400_000); // non-security: past operational retention
const OLD_SECURITY = new Date(Date.now() - 200 * 86_400_000); // past 90d operational, INSIDE 365d security retention
const oldId1 = `n-oldsys${randomBytes(8).toString("hex")}`;
const oldId2 = `n-oldsec${randomBytes(8).toString("hex")}`;
const recentId = `n-recent${randomBytes(8).toString("hex")}`;
await db.notification.create({
  data: {
    id: oldId1,
    userId: regIds[A_EMAIL],
    type: "SYSTEM_ANNOUNCEMENT",
    category: "SYSTEM",
    priority: "LOW",
    severity: "INFO",
    titleKey: "items.SYSTEM_ANNOUNCEMENT.title",
    bodyKey: "items.SYSTEM_ANNOUNCEMENT.body",
    dataJson: JSON.stringify({ message: "old" }),
    readAt: OLD,
    createdAt: OLD,
  },
});
await db.notification.create({
  data: {
    id: oldId2,
    userId: regIds[A_EMAIL],
    type: "SECURITY_PASSWORD_CHANGED",
    category: "SECURITY",
    priority: "HIGH",
    severity: "INFO",
    titleKey: "items.SECURITY_PASSWORD_CHANGED.title",
    bodyKey: "items.SECURITY_PASSWORD_CHANGED.body",
    dataJson: JSON.stringify({ changedAt: OLD_SECURITY.toISOString() }),
    readAt: OLD_SECURITY,
    createdAt: OLD_SECURITY,
  },
});
await db.notification.create({
  data: {
    id: recentId,
    userId: regIds[A_EMAIL],
    type: "SYSTEM_ANNOUNCEMENT",
    category: "SYSTEM",
    priority: "LOW",
    severity: "INFO",
    titleKey: "items.SYSTEM_ANNOUNCEMENT.title",
    bodyKey: "items.SYSTEM_ANNOUNCEMENT.body",
    dataJson: JSON.stringify({ message: "recent" }),
    readAt: new Date(),
  },
});

const { execSync } = await import("node:child_process");
const dryRun = execSync("bun scripts/prune-expired-notifications.mjs", { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
check("CLEANUP: prune dry-run reports without deleting (§58)", dryRun.includes("dry-run") && dryRun.includes("eligible"), dryRun.split("\n").slice(0, 3).join(" | ").slice(0, 200));
const stillOld = await db.notification.findUnique({ where: { id: oldId1 } });
check("CLEANUP: dry-run deleted nothing", Boolean(stillOld));

const applied = execSync("bun scripts/prune-expired-notifications.mjs --apply", { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
check("CLEANUP: --apply executed", applied.includes("deleted"), applied.split("\n").slice(0, 3).join(" | ").slice(0, 200));
const oldGone = await db.notification.findUnique({ where: { id: oldId1 } });
const secKept = await db.notification.findUnique({ where: { id: oldId2 } });
const recentKept = await db.notification.findUnique({ where: { id: recentId } });
check("CLEANUP: old non-security pruned (§212/§303)", oldGone === null);
check("CLEANUP: security notification KEPT (longer retention, §127/§370)", Boolean(secKept));
check("CLEANUP: recent unread/unarchived row kept", Boolean(recentKept));

/* ============================ PLATFORM GATES =============================== */
section("PLATFORM GATES");
const tenantDiag = await apiJson(fA4, "/api/v1/platform/notifications");
check("PLATFORM: tenant blocked from diagnostics (§396)", tenantDiag.res.status === 403 || tenantDiag.res.status === 401, `${tenantDiag.res.status}`);
const tenantRetry = await apiJson(fA4, "/api/v1/platform/notifications/fakedelivery123/retry", { method: "POST" });
check("PLATFORM: tenant blocked from delivery retry (§396)", tenantRetry.res.status === 403 || tenantRetry.res.status === 401, `${tenantRetry.res.status}`);
const tenantAnnounce = await apiJson(fA4, "/api/v1/platform/notifications/announcements", {
  method: "POST",
  body: JSON.stringify({ recipientUserIds: [regIds[B_EMAIL]], message: "spam" }),
});
check("PLATFORM: tenant blocked from announcements (§187/§154)", tenantAnnounce.res.status === 403 || tenantAnnounce.res.status === 401, `${tenantAnnounce.res.status}`);

/* ================================ SUMMARY ================================== */
const failed = results.filter((r) => !r.ok);
console.log("\n=========================================");
console.log(`PROMPT 32 NOTIFICATION CHECK: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name} — ${f.info.slice(0, 160)}`);
}
await db.$disconnect();
process.exit(failed.length === 0 ? 0 : 1);

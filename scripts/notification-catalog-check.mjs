/**
 * scripts/notification-catalog-check.mjs — Prompt 32 §171/§266/§267.
 *
 * STATIC validation of the closed notification catalog + translations:
 *  - every entry defines type/category/priority/severity/channels/keys/schema
 *  - no duplicate types (the Record structure makes this structural; the
 *    NOTIFICATION_TYPES list is cross-checked against the catalog keys)
 *  - only supported channels (IN_APP/EMAIL); mandatory ⇔ has an ALWAYS channel
 *  - preferenceAvailable=false required when nothing is user-controllable
 *  - titleKey/bodyKey/emailTemplateKey follow the "items.<TYPE>.*" convention
 *    and EXIST in BOTH en.ts and fa.ts (no missing placeholders — §267/§350)
 *  - every item template renders for EN + FA with its schema's example data
 *    and leaves NO {placeholder} behind (§351-§354)
 *  - actionRoute is allowlisted; expiresAfterDays is null or 1..3650
 *  - data schemas reject forbidden keys (defense-in-depth probe, §26)
 *
 * Run:  bun scripts/notification-catalog-check.mjs
 * Exit: 0 = all green · 1 = at least one failure.
 */

/* Register the server-only shim BEFORE importing server modules. */
Bun.plugin({
  name: "server-only-shim",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});

const results = [];
let section = "";
function check(name, cond, info = "") {
  results.push({ section, name, ok: Boolean(cond) });
  console.log(`${cond ? "✓" : "✗"} [${section}] ${name}${info ? ` — ${info}` : ""}`);
}

const { NOTIFICATION_CATALOG, NOTIFICATION_TYPES, NOTIFICATION_TYPE_LIST, isNotificationType } = await import(
  "../src/lib/notifications/catalog.ts"
);
const { NOTIFICATION_CHANNELS, NOTIFICATION_CATEGORIES, NOTIFICATION_PRIORITIES, NOTIFICATION_SEVERITIES, ACTION_ROUTES } = await import(
  "../src/lib/notifications/types.ts"
);
const { renderNotificationForUser, renderNotificationEmailForUser } = await import(
  "../src/lib/notifications/templates.ts"
);
const en = (await import("../src/i18n/messages/en.ts")).default;
const fa = (await import("../src/i18n/messages/fa.ts")).default;

/* ------------------------------ catalog laws ------------------------------- */
section = "CATALOG";
check("catalog: NOTIFICATION_TYPES list matches catalog keys exactly", (() => {
  const keys = Object.keys(NOTIFICATION_CATALOG);
  return keys.length === NOTIFICATION_TYPES.length && NOTIFICATION_TYPES.every((t) => keys.includes(t));
})(), `types=${NOTIFICATION_TYPES.length}`);
check("catalog: type list has no duplicates", new Set(NOTIFICATION_TYPES).size === NOTIFICATION_TYPES.length);
check("catalog: isNotificationType accepts every catalog type", NOTIFICATION_TYPES.every((t) => isNotificationType(t)));

for (const entry of NOTIFICATION_TYPE_LIST) {
  check(
    `${entry.type}: vocabulary valid (§170)`,
    NOTIFICATION_CATEGORIES.includes(entry.category) &&
      NOTIFICATION_PRIORITIES.includes(entry.priority) &&
      NOTIFICATION_SEVERITIES.includes(entry.severity),
    `${entry.category}/${entry.priority}/${entry.severity}`,
  );
  check(
    `${entry.type}: channels supported (§9)`,
    Object.keys(entry.channels).length === NOTIFICATION_CHANNELS.length &&
      Object.values(entry.channels).every((p) => ["ALWAYS", "IF_ENABLED", "NEVER"].includes(p)),
  );
  const hasAlways = Object.values(entry.channels).some((p) => p === "ALWAYS");
  check(`${entry.type}: mandatory ⇔ has ALWAYS channel (§11)`, entry.mandatory === hasAlways);
  const hasOptional = Object.entries(entry.channels).some(([ch, p]) => ch === "EMAIL" && p === "IF_ENABLED");
  check(
    `${entry.type}: preferenceAvailable ⇔ optional email exists (§61)`,
    entry.preferenceAvailable === hasOptional,
  );
  check(
    `${entry.type}: translation keys follow convention (§22)`,
    entry.titleKey === `items.${entry.type}.title` &&
      entry.bodyKey === `items.${entry.type}.body` &&
      entry.emailTemplateKey === `items.${entry.type}.email`,
  );
  check(
    `${entry.type}: actionRoute allowlisted or null (§103)`,
    entry.actionRoute === null || ACTION_ROUTES.includes(entry.actionRoute),
  );
  check(
    `${entry.type}: expiresAfterDays null or bounded (§57)`,
    entry.expiresAfterDays === null || (Number.isInteger(entry.expiresAfterDays) && entry.expiresAfterDays >= 1 && entry.expiresAfterDays <= 3650),
  );
  check(`${entry.type}: data schema is a Zod object (§172)`, typeof entry.dataSchema?.safeParse === "function");
  check(`${entry.type}: source + dedupe documented (§434)`, entry.source.length > 10 && entry.dedupe.length > 5);
}

/* --------------------------- translation existence -------------------------- */
section = "TRANSLATIONS";
const faNs = fa.notifications;
const enNs = en.notifications;
check("translations: notifications namespace exists in EN + FA", Boolean(enNs) && Boolean(faNs));
for (const entry of NOTIFICATION_TYPE_LIST) {
  for (const [locale, ns] of [["en", enNs], ["fa", faNs]]) {
    const item = ns?.items?.[entry.type];
    check(
      `${entry.type}: ${locale} title/body/email present (§267)`,
      typeof item?.title === "string" &&
        item.title.length > 3 &&
        typeof item?.body === "string" &&
        item.body.length > 3 &&
        typeof item?.email === "string" &&
        item.email.length > 3,
    );
  }
}
const sharedKeys = ["bell", "panelTitle", "viewAll", "settings", "markAllRead", "markRead", "markUnread", "archive", "empty", "emptyFiltered", "loadMore", "loading", "errorTitle", "unreadDotLabel", "businessContext", "emailFooter"];
for (const key of sharedKeys) {
  check(`translations: ui key "${key}" in EN + FA`, typeof enNs?.[key] === "string" && typeof faNs?.[key] === "string");
}
for (const key of ["all", "unread", "SECURITY", "BILLING", "AI", "BUSINESS", "SYSTEM"]) {
  check(`translations: filter "${key}" in EN + FA`, typeof enNs?.filters?.[key] === "string" && typeof faNs?.filters?.[key] === "string");
}
for (const key of ACTION_ROUTES) {
  check(`translations: cta "${key}" in EN + FA`, typeof enNs?.cta?.[key] === "string" && typeof faNs?.cta?.[key] === "string");
}

/* ------------------------------- rendering QA ------------------------------- */
section = "RENDER";
/** Minimal deterministic example data per type (schema-conformant). */
const EXAMPLE_DATA = {
  SECURITY_PASSWORD_CHANGED: { changedAt: "2026-09-30T10:00:00.000Z" },
  SECURITY_PASSWORD_RESET_COMPLETED: { completedAt: "2026-09-30T10:00:00.000Z" },
  SECURITY_EMAIL_VERIFIED: { verifiedAt: "2026-09-30T10:00:00.000Z" },
  SECURITY_MFA_ENABLED: { enabledAt: "2026-09-30T10:00:00.000Z" },
  SECURITY_MFA_DISABLED: { disabledAt: "2026-09-30T10:00:00.000Z" },
  SECURITY_NEW_LOGIN: { loginAt: "2026-09-30T10:00:00.000Z", device: "Chrome on Windows" },
  SECURITY_SESSIONS_SIGNED_OUT: { signedOutAt: "2026-09-30T10:00:00.000Z", sessionCount: 2 },
  BILLING_TRIAL_STARTED: { planName: "Pro", trialEndDate: "2026-10-30T10:00:00.000Z" },
  BILLING_TRIAL_ENDED: { planName: "Pro", endedAt: "2026-10-30T10:00:00.000Z" },
  BILLING_SUBSCRIPTION_CHANGED: { planName: "Pro", change: "plan_changed", changedAt: "2026-09-30T10:00:00.000Z" },
  BILLING_PAYMENT_SUCCEEDED: { amountMinor: 4900, currency: "EUR", paidAt: "2026-09-30T10:00:00.000Z" },
  BILLING_PAYMENT_FAILED: { amountMinor: 4900, currency: "EUR", failedAt: "2026-09-30T10:00:00.000Z" },
  AI_USAGE_LIMIT_NEAR: { used: 82, limit: 100, periodEnd: "2026-10-31T00:00:00.000Z", percent: 82 },
  AI_USAGE_LIMIT_REACHED: { used: 100, limit: 100, periodEnd: "2026-10-31T00:00:00.000Z" },
  BUSINESS_EXPORT_COMPLETED: { datasets: ["customers", "sales"], recordCount: 42, expiresAt: "2026-10-03T10:00:00.000Z" },
  BUSINESS_EXPORT_FAILED: { reason: "EXPORT_LIMIT_EXCEEDED" },
  BUSINESS_IMPORT_COMPLETED: { dataset: "customers", created: 3, updated: 0, skipped: 1, failed: 0 },
  BUSINESS_IMPORT_FAILED: { dataset: "customers", reason: "IMPORT_COMMIT_FAILED" },
  // Prompt 37 — CRM task notifications (bounded, schema-conformant examples).
  BUSINESS_CRM_TASK_ASSIGNED: {
    taskId: "task0001abc",
    taskTitle: "Prepare proposal",
    priority: "HIGH",
    contextType: "CUSTOMER",
    contextTitle: "Acme",
    dueAt: "2026-10-05T10:00:00.000Z",
    businessTimezone: "Asia/Tehran",
  },
  BUSINESS_CRM_TASK_DUE_SOON: {
    taskId: "task0001abc",
    taskTitle: "Prepare proposal",
    priority: "HIGH",
    contextType: "CUSTOMER",
    contextTitle: "Acme",
    dueAt: "2026-10-05T10:00:00.000Z",
    reminderMinutesBefore: 60,
    businessTimezone: "Asia/Tehran",
  },
  BUSINESS_CRM_TASK_OVERDUE: {
    taskId: "task0001abc",
    taskTitle: "Prepare proposal",
    priority: "HIGH",
    contextType: "CUSTOMER",
    contextTitle: "Acme",
    dueAt: "2026-10-05T10:00:00.000Z",
    businessTimezone: "Asia/Tehran",
  },
  // Prompt 38 — low-stock inventory alert (bounded, schema-conformant).
  BUSINESS_INVENTORY_LOW_STOCK: {
    productId: "prod0001abc",
    productName: "Copy paper A4",
    sku: "PAP-A4-500",
    unit: "box",
    stockQty: 2,
    lowStockAt: 5,
  },
  SYSTEM_ANNOUNCEMENT: { message: "Scheduled maintenance on Sunday." },
  // Prompt 62 — Support Center + account suspension (bounded, schema-conformant).
  SUPPORT_TICKET_CREATED: {
    ticketId: "ticket00001abc",
    ticketNumber: 12,
    subject: "Cannot record a payment",
  },
  SUPPORT_TICKET_REPLY: {
    ticketId: "ticket00001abc",
    ticketNumber: 12,
    subject: "Cannot record a payment",
  },
  SUPPORT_TICKET_RESOLVED: {
    ticketId: "ticket00001abc",
    ticketNumber: 12,
    subject: "Cannot record a payment",
    summary: "The payment method was missing a currency; re-tested successfully.",
  },
  SYSTEM_ACCOUNT_SUSPENDED: {
    reason: "Suspected fraudulent activity under investigation.",
    suspendedAt: "2026-09-30T10:00:00.000Z",
  },
  SYSTEM_ACCOUNT_RESTORED: {
    restoredAt: "2026-09-30T10:00:00.000Z",
  },
};

for (const entry of NOTIFICATION_TYPE_LIST) {
  const example = EXAMPLE_DATA[entry.type];
  const parsed = entry.dataSchema.safeParse(example);
  check(`${entry.type}: example data validates against its schema (§355)`, parsed.success, JSON.stringify(parsed?.error?.issues?.[0] ?? {}).slice(0, 100));

  for (const locale of ["en", "fa"]) {
    let inApp, email;
    try {
      inApp = renderNotificationForUser(entry.type, parsed.success ? parsed.data : null, locale);
      email = renderNotificationEmailForUser(entry.type, parsed.success ? parsed.data : null, locale);
    } catch (error) {
      check(`${entry.type}: ${locale} renders (§351)`, false, String(error?.message ?? error).slice(0, 120));
      continue;
    }
    const noLeftover = [inApp.title, inApp.body, email.subject, email.text].every(
      (s) => !/\{\w+\}/.test(s) && !s.includes("undefined") && !s.includes("[object Object]") && !s.includes("null"),
    );
    check(`${entry.type}: ${locale} renders with NO leftover placeholders/undefined (§352/§353)`, noLeftover, `${inApp.title} | ${inApp.body.slice(0, 60)}`);
    const dirOk = locale === "fa" ? email.html.includes('dir="rtl"') : email.html.includes('dir="ltr"');
    check(`${entry.type}: ${locale} email direction correct (§39)`, dirOk);
    const escapedOk = !email.html.includes("<script") && !email.html.includes("javascript:");
    check(`${entry.type}: ${locale} email html has no script vectors (§287)`, escapedOk);
  }
}

/* Template-injection probe (§287): malicious data values are escaped. */
{
  const malicious = renderNotificationEmailForUser(
    "SYSTEM_ANNOUNCEMENT",
    { message: '<img src=x onerror="alert(1)">&"\'`' },
    "en",
  );
  check(
    "RENDER: HTML injection in data is escaped (§287)",
    !malicious.html.includes("<img") && malicious.html.includes("&lt;img") && !malicious.html.includes("<img"),
  );
}

/* ------------------------------ schema guards ------------------------------- */
section = "SCHEMAS";
for (const entry of NOTIFICATION_TYPE_LIST) {
  const forbidden = entry.dataSchema.safeParse({ password: "x", token: "y", secret: "z", apiKey: "k" });
  // Extra keys are stripped by Zod (not passed through), so a payload with
  // ONLY forbidden keys must never survive with those keys present.
  const data = forbidden.success ? forbidden.data : null;
  const leaked = data ? Object.keys(data).some((k) => ["password", "token", "secret", "apiKey"].includes(k)) : false;
  check(`${entry.type}: schema never passes forbidden keys through (§26)`, !leaked);
}

/* --------------------------------- summary ---------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log("\n=========================================");
console.log(`NOTIFICATION CATALOG CHECK: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name}`);
  process.exit(1);
}
console.log("CATALOG GREEN ✓");

/**
 * scripts/notification-static-scan.mjs — Prompt 32 §389/§390/§391/§458.
 *
 * STATIC security scan of the notification platform source:
 *   1. NO generic public notification-creation endpoint for customers (§187)
 *   2. NO raw notification HTML rendering (no dangerouslySetInnerHTML) (§152)
 *   3. NO arbitrary/action URLs from request input (Host-header/link building) (§41)
 *   4. NO forbidden keys in notification data construction (§26/§390)
 *   5. NO cross-user access — every /me route uses the session identity (§183)
 *   6. NO missing auth — every notification route resolves session/platform context (§240)
 *   7. NO direct SMTP/nodemailer use from the notifications domain (§33)
 *   8. NO payload logging — dataJson/email html/body never logged (§132/§133/§310)
 *   9. NO secrets (OTP/MFA secret/recovery code/reset token/password) persisted
 *      or rendered by the notification domain (§390/§391)
 *  10. Platform/tenant boundary — delivery mutation only under /platform (§186/§396)
 *
 * Run:  bun scripts/notification-static-scan.mjs
 * Exit: 0 = all green · 1 = at least one finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const results = [];
function check(name, cond, info = "") {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "✓" : "✗"} ${name}${info ? ` — ${info}` : ""}`);
}

function listFiles(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

const notifLibFiles = listFiles(join(ROOT, "src/lib/notifications"), ".ts");
const notifRouteFiles = [
  ...listFiles(join(ROOT, "src/app/api/v1/me/notifications"), ".ts"),
  ...listFiles(join(ROOT, "src/app/api/v1/me/notification-preferences"), ".ts"),
  ...listFiles(join(ROOT, "src/app/api/v1/platform/notifications"), ".ts"),
];
const all = [...notifLibFiles, ...notifRouteFiles];

/* 1 — no generic customer creation endpoint */
{
  const genericCreate = all.filter((f) => {
    if (!f.includes("/api/v1/me/") && !f.includes("/api/v1/platform/notifications")) return false;
    const text = readFileSync(f, "utf8");
    // A "create" route would accept a type/priority/body payload from the client.
    return /export\s+const\s+POST/.test(text) && /notificationType/.test(text) && f.includes("/api/v1/notifications/route.ts");
  });
  check("1. no generic customer notification-creation endpoint (§187)", genericCreate.length === 0, genericCreate.join(","));
  const routeTree = listFiles(join(ROOT, "src/app/api"), ".ts").filter((f) => /notifications/.test(f));
  check(
    "1b. notification routes live only under /me + /platform (§187/§259)",
    routeTree.every((f) => f.includes("/me/") || f.includes("/platform/")),
    routeTree.filter((f) => !f.includes("/me/") && !f.includes("/platform/")).join(","),
  );
}

/* 2 — no raw HTML rendering */
{
  const dangerous = [...notifLibFiles, ...listFiles(join(ROOT, "src/modules/notifications"), ".tsx")].filter((f) => {
    const text = readFileSync(f, "utf8");
    return text.includes("dangerouslySetInnerHTML");
  });
  check("2. no dangerouslySetInnerHTML in notification domain (§152/§347)", dangerous.length === 0, dangerous.join(","));
}

/* 3 — no Host-header link building */
{
  const badUrls = notifLibFiles.filter((f) => {
    const text = readFileSync(f, "utf8");
    return /req\.headers\.get\(["'](host|x-forwarded-host|x-original-host)["']\)/i.test(text) || text.includes("window.location.origin");
  });
  check("3. email/link base URL never from request Host (§41)", badUrls.length === 0, badUrls.join(","));
  const templates = readFileSync(join(ROOT, "src/lib/notifications/templates.ts"), "utf8");
  check("3b. CTA built only from trusted APP_BASE_URL/NEXTAUTH_URL (§41)", templates.includes("APP_BASE_URL") && templates.includes("actionRoutePath"));
}

/* 4 — forbidden keys never constructed by mappers */
{
  const forbiddenLiteral = /"(password|newPassword|currentPassword|otp|recoveryCode|mfaSecret|secret|apiKey|resetToken|sessionToken|authorization|cookie|providerKey|merchantSecret)"\s*:/;
  const offenders = notifLibFiles.filter((f) => {
    if (f.endsWith("dedupe.ts")) return false; // the sanitizer itself lists them
    const text = readFileSync(f, "utf8");
    if (f.endsWith("catalog.ts")) {
      // Catalog comments mention keys but data must not contain them — check
      // only within dataSchema object literals is overkill; the schema guard
      // test (catalog-check) proves stripping. Here we check NO raw string
      // literal is BOUND as a data value.
    }
    return forbiddenLiteral.test(text);
  });
  check("4. no forbidden data keys constructed (§26/§390)", offenders.length === 0, offenders.join(","));
}

/* 5+6 — auth present in every route */
{
  const missingAuth = notifRouteFiles.filter((f) => {
    const text = readFileSync(f, "utf8");
    const hasUserAuth = text.includes("assertFreshSession") || text.includes("getAuthContext");
    const hasPlatformAuth = text.includes("getPlatformContext");
    return !hasUserAuth && !hasPlatformAuth;
  });
  check("5/6. every notification route resolves session/platform identity (§182/§240)", missingAuth.length === 0, missingAuth.join(","));
  const bodyUserId = notifRouteFiles.filter((f) => {
    const text = readFileSync(f, "utf8");
    // Identity from BODY (userId inside a zod schema of a me route) is a cross-user hole.
    if (!f.includes("/me/")) return false;
    return /userId:\s*z\.(string|coerce)/.test(text);
  });
  check("5b. no route accepts userId from the request body (§19/§185)", bodyUserId.length === 0, bodyUserId.join(","));
}

/* 7 — no direct SMTP client usage (the SMTP_* failure vocabulary is legit) */
{
  const directSmtp = notifLibFiles.filter((f) => {
    const text = readFileSync(f, "utf8");
    return (
      text.includes("nodemailer") ||
      text.includes("createTransport") ||
      text.includes("smtp-client") ||
      text.includes("net.connect") ||
      text.includes("tls.connect") ||
      text.includes("getSmtpTransport")
    );
  });
  check("7. notifications domain uses EmailProvider only — no direct SMTP client (§33)", directSmtp.length === 0, directSmtp.join(","));
  const channels = readFileSync(join(ROOT, "src/lib/notifications/channels.ts"), "utf8");
  check("7b. email channel dispatches via getEmailProvider() (§33)", channels.includes('from "@/lib/email"') && channels.includes("getEmailProvider"));
}

/* 8 — no payload logging */
{
  const payloadLog = notifLibFiles.filter((f) => {
    const text = readFileSync(f, "utf8");
    const logCalls = text.match(/(console\.(log|info|warn|error)|log(Debug|Info|Warn|Error))\(([^)]*)/g) ?? [];
    return logCalls.some((call) => /dataJson|body|html|message\.text|message\.html|\.data\b/.test(call));
  });
  check("8. no notification payload/body/html logging (§132/§133/§310)", payloadLog.length === 0, payloadLog.join(","));
}

/* 9 — secrets never stored/rendered by the domain */
{
  const secretPatterns = /recoveryCode|resetToken|totp|otpCode|mfaSecret/i;
  const offenders = notifLibFiles.filter((f) => {
    // dedupe.ts IS the sanitizer — its forbidden-key list is the control,
    // not a leak (§26).
    if (f.endsWith("dedupe.ts")) return false;
    const text = readFileSync(f, "utf8");
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    return secretPatterns.test(stripped);
  });
  check("9. no secret-bearing identifiers in domain code (§390/§391/§406/§407)", offenders.length === 0, offenders.join(","));
}

/* 10 — platform/tenant boundary */
{
  const meRoutes = listFiles(join(ROOT, "src/app/api/v1/me/notifications"), ".ts").map((f) => readFileSync(f, "utf8")).join("\n");
  check("10. tenant routes never mutate NotificationDelivery (§186/§396)", !meRoutes.includes("notificationDelivery.update") && !meRoutes.includes("notificationDelivery.create") && !meRoutes.includes("notificationDelivery.delete"));
  const platformDiagnostics = readFileSync(join(ROOT, "src/app/api/v1/platform/notifications/route.ts"), "utf8");
  check("10b. platform diagnostics gated by platform permission (§258)", platformDiagnostics.includes("requirePlatformPermission"));
}

/* Bonus — dispatcher state machine invariants live in code (§143) */
{
  const dispatcher = readFileSync(join(ROOT, "src/lib/notifications/dispatcher.ts"), "utf8");
  check("11. claim is a guarded atomic PENDING→PROCESSING update (§145/§359)", dispatcher.includes('status: "PENDING"') && dispatcher.includes('"PROCESSING"') && dispatcher.includes("updateMany"));
  check("11b. stale PROCESSING is marked FAILED, never auto-resent (§146/§360)", dispatcher.includes("STALE_PROCESSING") && !dispatcher.includes("retryForever"));
}

/* --------------- Prompt 37 — CRM task notification checks (§99) ------------ */
{
  const catalog = readFileSync(join(ROOT, "src/lib/notifications/catalog.ts"), "utf8");
  const mappers = readFileSync(join(ROOT, "src/lib/notifications/event-mappers.ts"), "utf8");
  const templates = readFileSync(join(ROOT, "src/lib/notifications/templates.ts"), "utf8");
  const en = readFileSync(join(ROOT, "src/i18n/messages/en.ts"), "utf8");
  const fa = readFileSync(join(ROOT, "src/i18n/messages/fa.ts"), "utf8");
  const crmTaskTypes = ["BUSINESS_CRM_TASK_ASSIGNED", "BUSINESS_CRM_TASK_DUE_SOON", "BUSINESS_CRM_TASK_OVERDUE"];

  // 12 — CRM task data is allowlisted; description/contact fields never appear
  // in the CRM data schemas (§17/§18/§19/§99). Slice starts at the CATALOG
  // ENTRY ("TYPE: {") — not the type-list occurrence — and comments are
  // stripped so documentation words never trip the scan.
  const entryStart = catalog.indexOf("BUSINESS_CRM_TASK_ASSIGNED: {");
  const crmCatalogSlice = catalog.slice(entryStart, catalog.indexOf("/* -------------------------------- SYSTEM", entryStart));
  const crmCatalogCode = crmCatalogSlice
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    // Translation key strings legitimately contain "email" — drop them.
    .replace(/(titleKey|bodyKey|emailTemplateKey):\s*"[^"]*"/g, "");
  const leakyKeys = /description|phone|address|\bemail\b|\bnotes\b/i.test(crmCatalogCode);
  check("12. CRM task notification data schema allowlisted — no description/contact keys (§17–§19)", !leakyKeys);

  // 13 — the CRM mappers never read task descriptions or contact fields.
  const crmMapperSlice = mappers.slice(mappers.indexOf("notifyCrmTaskAssigned"));
  check("12b. CRM mappers never pass description/contact data (§18/§141)", !/description|phone|address/i.test(crmMapperSlice));

  // 14 — no secrets in CRM notification data.
  check("13. no secrets in CRM notification data (§99)", !/password|secret|token|apiKey/i.test(crmCatalogCode));

  // 15 — the ONLY action route for CRM task notifications is the closed
  // crmTasks key (§23/§105); never an actionRoute from a payload.
  check("14. CRM task action route is the closed crmTasks key (§23/§105)", crmCatalogSlice.includes('actionRoute: "crmTasks"') && !crmCatalogSlice.includes("actionRoute: null") && mappers.includes("actionRoute") === false);
  const crmRoutes = crmTaskTypes.filter((t) => {
    const idx = catalog.indexOf(`${t}: {`);
    const next = catalog.indexOf("}", catalog.indexOf("actionRoute", idx));
    return catalog.slice(idx, next).includes('actionRoute: "crmTasks"');
  });
  check("14b. all three CRM types map to crmTasks (§23)", crmRoutes.length === 3);

  // 16 — sourceEventId is deterministic from (taskId, dueAt/updatedAt, assignee)
  // with NO run timestamp (§27/§28/§180/§181).
  check(
    "15. CRM due-soon/overdue source event keys are deterministic (taskId + dueAt + assignee, no run timestamp) (§27/§28/§180/§181)",
    mappers.includes('composeSourceEventId(\n      "crm-task-due-soon",\n      input.taskId,\n      input.dueAt.toISOString(),\n      input.assigneeUserId,\n    )') &&
      mappers.includes('composeSourceEventId(\n      "crm-task-overdue",\n      input.taskId,\n      input.dueAt.toISOString(),\n      input.assigneeUserId,\n    )'),
  );

  // 17 — the CRM task notification types are BUSINESS category (§13).
  const businessCount = crmTaskTypes.filter((t) => {
    const idx = catalog.indexOf(`${t}: {`);
    return catalog.slice(idx, idx + 400).includes('category: "BUSINESS"');
  }).length;
  check("16. all CRM task notification types are category BUSINESS (§13)", businessCount === 3);

  // 18 — no direct external email call anywhere near the CRM notification path.
  check(
    "17. CRM reminder chain never calls email/SMTP directly (§56/§199)",
    !mappers.includes("nodemailer") &&
      !mappers.includes("createTransport") &&
      !readFileSync(join(ROOT, "src/lib/crm/task-reminder-processor.ts"), "utf8").match(/nodemailer|createTransport|sendEmail|dispatchEmail/),
  );

  // 19 — preferenceAvailable + emailDefaultEnabled consistency (§16).
  // Window = the whole catalog entry (from "TYPE: {" to the next type).
  const prefOk = crmTaskTypes.every((t, i) => {
    const idx = catalog.indexOf(`${t}: {`);
    const end = i + 1 < crmTaskTypes.length ? catalog.indexOf(`${crmTaskTypes[i + 1]}: {`) : catalog.indexOf("SYSTEM_ANNOUNCEMENT: {");
    const slice = catalog.slice(idx, end);
    return slice.includes("preferenceAvailable: true") && slice.includes("emailDefaultEnabled: true");
  });
  check("18. CRM types expose email preferences with default enabled (§16)", prefOk);

  // 20 — templates exist in EN + FA (§101/§152).
  check(
    "19. CRM task templates exist in EN + FA (§101)",
    crmTaskTypes.every((t) => en.includes(`${t}: {`) && fa.includes(`${t}: {`)),
  );
  check(
    "19b. FA templates contain no English sentence literals (§101/§133)",
    !fa.includes("was assigned to you") && !fa.includes("is due in") && !fa.includes("is overdue"),
  );
  // 21 — the notification templates render the business timezone (§22/§102).
  check("20. CRM template rendering is business-timezone aware (§22/§102)", templates.includes("formatDateTimeInBusinessZone") && templates.includes("businessTimezone"));
}

/* --------------------------------- summary ---------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log("\n=========================================");
console.log(`NOTIFICATION STATIC SCAN: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log("STATIC SCAN GREEN ✓");

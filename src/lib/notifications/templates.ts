import "server-only";
import { messagesFor, type Messages } from "@/i18n/messages";
import { findCurrency } from "@/lib/currencies";
import { formatMoney } from "@/lib/money";
import { NOTIFICATION_CATALOG, type NotificationType } from "./catalog";
import type { ActionRoute } from "./types";
import { actionRoutePath } from "./types";

/**
 * Notification rendering — Prompt 32 §21/§22/§35/§148/§191/§192/§348/§349.
 *
 * - Localized text is NEVER persisted (§192): rows store translation KEYS
 *   plus a schema-validated data object; this module renders them at read
 *   time in the user's locale (§193 — historical rows re-render in the
 *   current locale).
 * - Email rendering is server-side only (§35), dir=rtl for Persian / ltr
 *   for English (§39 — never the browser's guess), and every interpolated
 *   value is HTML-escaped (§287 injection test).
 * - Emails never contain secrets (§40) and stay small: they summarize and
 *   link into the app (§232/§233).
 */

type SafeValues = Record<string, string | number>;

/** Replace {placeholder} tokens; unknown tokens stay visible (fails loud in QA). */
function interpolate(template: string, values: SafeValues): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/** Localized timestamp (§115/§428 — display only; storage is always UTC). */
function formatDateTime(iso: string, locale: "en" | "fa"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Prompt 37 (§22/§102/§138/§139) — business-timezone-aware timestamp for
 * CRM task notifications. The timezone comes from the SERVER-validated
 * notification data (Business.timezone — never the browser/request). Law:
 *  1. validate the IANA zone by constructing an Intl formatter,
 *  2. fall back safely to UTC on any invalid value,
 *  3. never throw, never trust an arbitrary timezone string,
 *  4. DST-correct — Intl.DateTimeFormat handles transitions natively;
 *     no manual offset math, no hardcoded city.
 */
function formatDateTimeInBusinessZone(
  iso: string,
  locale: "en" | "fa",
  timeZone: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let tz = "UTC";
  try {
    const probe = new Intl.DateTimeFormat("en-CA", { timeZone });
    tz = probe.resolvedOptions().timeZone || "UTC";
  } catch {
    tz = "UTC";
  }
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tz,
  }).format(date);
}

function formatNumber(value: number, locale: "en" | "fa"): string {
  return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US").format(value);
}

/** Minor units → exact localized money string. Currency is ALWAYS rendered (§163). */
function formatMinorAmount(amountMinor: number, currency: string, locale: "en" | "fa"): string {
  const config = findCurrency(currency);
  if (!config) return `${formatNumber(amountMinor, locale)} ${currency}`;
  return formatMoney(
    amountMinor,
    { currencyCode: config.code, currencySymbol: config.symbol, decimalPrecision: config.precision, locale },
    { locale, withCode: true },
  );
}

/** Localized dataset label list (bounded, allowlisted keys only). */
function datasetLabels(datasets: readonly string[], locale: "en" | "fa"): string {
  const messages = messagesFor(locale).notifications;
  const labels = datasets
    .slice(0, 8)
    .map((key) => {
      const map = messages.datasets as Record<string, string>;
      return map[key] ?? key;
    });
  return labels.join(locale === "fa" ? "، " : ", ");
}

/**
 * Prompt 37 (§52/§101) — localized TASK priority label, reusing the CRM
 * priority vocabulary translations (crm.tasks.priority). Unknown values
 * fall back to the raw token (schema-validated upstream).
 */
function crmPriorityLabel(priority: string, locale: "en" | "fa"): string {
  const map = messagesFor(locale).crm?.tasks?.priority as Record<string, string> | undefined;
  return map?.[priority] ?? priority;
}

/**
 * Prompt 37 (§53/§101) — localized due-soon lead time, reusing the
 * crm.taskReminder.offsets vocabulary keyed by the closed minute values.
 * Falls back to the formatted raw minutes.
 */
function crmReminderOffsetLabel(minutes: number, locale: "en" | "fa"): string {
  const map = messagesFor(locale).crm?.taskReminder?.offsets as Record<string, string> | undefined;
  return map?.[String(minutes)] ?? formatNumber(minutes, locale);
}

/**
 * Prompt 37 (§52) — localized context type label (Customer/Lead/Opportunity),
 * reusing the crm.activities.contextType vocabulary.
 */
function crmContextLabel(type: string, locale: "en" | "fa"): string {
  const map = messagesFor(locale).crm?.activities?.contextType as Record<string, string> | undefined;
  return map?.[type] ?? type;
}

/** Prompt 37 — localized "no due date" filler for assigned tasks without dueAt. */
function crmNoDueDateLabel(locale: "en" | "fa"): string {
  const map = messagesFor(locale).crm?.tasks?.contextCard as Record<string, string> | undefined;
  return map?.noDueDate ?? "";
}

/**
 * Compute the SAFE interpolation values for a type's templates. Only values
 * from the per-type schema (already validated upstream) enter here; nothing
 * raw from events or requests is ever interpolated (§229/§25).
 */
function deriveValues(type: NotificationType, data: Record<string, unknown>, locale: "en" | "fa"): SafeValues {
  const messages = messagesFor(locale).notifications;
  const changeMap = messages.change as Record<string, string>;
  const reasonMap = messages.reason as Record<string, string>;
  switch (type) {
    case "SECURITY_PASSWORD_CHANGED":
    case "SECURITY_PASSWORD_RESET_COMPLETED":
    case "SECURITY_EMAIL_VERIFIED":
    case "SECURITY_MFA_ENABLED":
    case "SECURITY_MFA_DISABLED":
      return { date: formatDateTime(String(data.changedAt ?? data.completedAt ?? data.verifiedAt ?? data.enabledAt ?? data.disabledAt), locale) };
    case "SECURITY_NEW_LOGIN":
      return { date: formatDateTime(String(data.loginAt), locale), device: String(data.device ?? "") };
    case "SECURITY_SESSIONS_SIGNED_OUT":
      return {
        date: formatDateTime(String(data.signedOutAt), locale),
        count: formatNumber(Number(data.sessionCount ?? 0), locale),
      };
    case "BILLING_TRIAL_STARTED":
      return { plan: String(data.planName ?? ""), endDate: formatDateTime(String(data.trialEndDate), locale) };
    case "BILLING_TRIAL_ENDED":
      return { plan: String(data.planName ?? ""), date: formatDateTime(String(data.endedAt), locale) };
    case "BILLING_SUBSCRIPTION_CHANGED":
      return {
        plan: String(data.planName ?? ""),
        change: changeMap[String(data.change)] ?? String(data.change),
        date: formatDateTime(String(data.changedAt), locale),
      };
    case "BILLING_PAYMENT_SUCCEEDED":
    case "BILLING_PAYMENT_FAILED":
      return {
        amount: formatMinorAmount(Number(data.amountMinor ?? 0), String(data.currency ?? "USD"), locale),
        date: formatDateTime(String(data.paidAt ?? data.failedAt), locale),
      };
    case "AI_USAGE_LIMIT_NEAR":
      return {
        used: formatNumber(Number(data.used ?? 0), locale),
        limit: formatNumber(Number(data.limit ?? 0), locale),
        date: formatDateTime(String(data.periodEnd), locale),
      };
    case "AI_USAGE_LIMIT_REACHED":
      return {
        used: formatNumber(Number(data.used ?? 0), locale),
        limit: formatNumber(Number(data.limit ?? 0), locale),
        date: formatDateTime(String(data.periodEnd), locale),
      };
    case "BUSINESS_EXPORT_COMPLETED":
      return {
        datasets: datasetLabels(Array.isArray(data.datasets) ? (data.datasets as string[]) : [], locale),
        count: formatNumber(Number(data.recordCount ?? 0), locale),
        date: data.expiresAt ? formatDateTime(String(data.expiresAt), locale) : "",
      };
    case "BUSINESS_EXPORT_FAILED":
      return { reason: reasonMap[String(data.reason)] ?? String(data.reason ?? "") };
    case "BUSINESS_IMPORT_COMPLETED":
      return {
        dataset: (messages.datasets as Record<string, string>)[String(data.dataset)] ?? String(data.dataset ?? ""),
        created: formatNumber(Number(data.created ?? 0), locale),
        skipped: formatNumber(Number(data.skipped ?? 0), locale),
        failed: formatNumber(Number(data.failed ?? 0), locale),
      };
    case "BUSINESS_IMPORT_FAILED":
      return {
        dataset: (messages.datasets as Record<string, string>)[String(data.dataset)] ?? String(data.dataset ?? ""),
        reason: reasonMap[String(data.reason)] ?? String(data.reason ?? ""),
      };
    case "BUSINESS_CRM_TASK_ASSIGNED":
      return {
        task: String(data.taskTitle ?? ""),
        context: String(data.contextTitle ?? ""),
        contextLabel: crmContextLabel(String(data.contextType ?? ""), locale),
        priority: crmPriorityLabel(String(data.priority ?? ""), locale),
        due: data.dueAt
          ? formatDateTimeInBusinessZone(String(data.dueAt), locale, String(data.businessTimezone ?? "UTC"))
          : crmNoDueDateLabel(locale),
      };
    case "BUSINESS_CRM_TASK_DUE_SOON":
      return {
        task: String(data.taskTitle ?? ""),
        context: String(data.contextTitle ?? ""),
        contextLabel: crmContextLabel(String(data.contextType ?? ""), locale),
        priority: crmPriorityLabel(String(data.priority ?? ""), locale),
        due: formatDateTimeInBusinessZone(String(data.dueAt), locale, String(data.businessTimezone ?? "UTC")),
        reminder: crmReminderOffsetLabel(Number(data.reminderMinutesBefore ?? 0), locale),
      };
    case "BUSINESS_CRM_TASK_OVERDUE":
      return {
        task: String(data.taskTitle ?? ""),
        context: String(data.contextTitle ?? ""),
        contextLabel: crmContextLabel(String(data.contextType ?? ""), locale),
        priority: crmPriorityLabel(String(data.priority ?? ""), locale),
        due: formatDateTimeInBusinessZone(String(data.dueAt), locale, String(data.businessTimezone ?? "UTC")),
      };
    case "BUSINESS_INVENTORY_LOW_STOCK": {
      // Prompt 38 (§38-a) — quantities use the locale numeral system; the
      // unit label is the product's own unit string (or a dash when unset).
      // SKU is optional in the schema and rendered as a dash when absent —
      // never an empty "{sku}" hole in the sentence.
      const sku = data.sku == null ? "" : String(data.sku);
      return {
        product: String(data.productName ?? ""),
        stock: formatNumber(Number(data.stockQty ?? 0), locale),
        threshold: formatNumber(Number(data.lowStockAt ?? 0), locale),
        unit: data.unit == null || data.unit === "" ? "–" : String(data.unit),
        sku: sku === "" ? "–" : sku,
      };
    }
    case "SYSTEM_ANNOUNCEMENT":
      return { message: String(data.message ?? "") };
    default: {
      // Exhaustiveness guard — a new catalog type MUST add a case above.
      const exhaustive: never = type;
      throw new Error(`No display-value derivation for notification type: ${exhaustive}`);
    }
  }
}

type NotificationItemMessages = {
  title: string;
  body: string;
  email: string;
};

function itemMessages(type: NotificationType, locale: "en" | "fa"): NotificationItemMessages {
  const items = (messagesFor(locale) as Messages).notifications.items as Record<
    string,
    NotificationItemMessages
  >;
  const entry = items[type];
  if (!entry) throw new Error(`Missing notification translations for ${type} (${locale})`);
  return entry;
}

export type RenderedInAppNotification = {
  title: string;
  body: string;
};

/**
 * renderNotificationForUser (§348) — server-side localized title/body for
 * one notification. Plain strings only; the client renders them as text
 * (never HTML — §151/§152/§347).
 */
export function renderNotificationForUser(
  type: NotificationType,
  data: Record<string, unknown> | null,
  locale: "en" | "fa",
): RenderedInAppNotification {
  const entry = NOTIFICATION_CATALOG[type];
  const messages = itemMessages(type, locale);
  const values = deriveValues(type, data ?? {}, locale);
  return {
    title: interpolate(messages.title, values),
    body: interpolate(messages.body, values),
  };
}

/* ------------------------------ email rendering --------------------------- */

/** HTML escape — identical contract to the Prompt 29 email templates (§22). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Absolute CTA URL for an allowlisted internal route (§41/§42/§102/§103).
 * Built from trusted configuration ONLY (never the request Host header).
 * Returns null when no base URL is configured — the email still sends
 * without a link rather than linking somewhere untrusted.
 */
function ctaUrl(route: ActionRoute): string | null {
  const base = (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? "").trim();
  if (!base) return null;
  try {
    const url = new URL(`${base.replace(/\/+$/, "")}/${actionRoutePath(route)}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type RenderedNotificationEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * renderNotificationEmailForUser (§349) — deterministic, bounded, localized
 * email (subject/text/html) for one notification type. The subject is the
 * localized title; the body is the type's email template; the CTA (if any)
 * is the allowlisted internal route. NO secrets are ever passed here (§40).
 */
export function renderNotificationEmailForUser(
  type: NotificationType,
  data: Record<string, unknown> | null,
  locale: "en" | "fa",
): RenderedNotificationEmail {
  const entry = NOTIFICATION_CATALOG[type];
  const messages = itemMessages(type, locale);
  const values = deriveValues(type, data ?? {}, locale);
  const subject = interpolate(messages.title, values);
  const body = interpolate(messages.email, values);
  const ctaLabel = messagesFor(locale).notifications.cta[entry.actionRoute ?? "dashboard"];
  const url = entry.actionRoute ? ctaUrl(entry.actionRoute) : null;

  const textLines = [body];
  if (url) textLines.push("", `${ctaLabel}: ${url}`);
  const text = textLines.join("\n");

  const dir = locale === "fa" ? "rtl" : "ltr";
  const bodyHtml = escapeHtml(body)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p style="font-size:14px;line-height:1.7;color:#374151;margin:0 0 12px;">${line}</p>`)
    .join("");
  const ctaHtml = url
    ? `<p style="text-align:center;margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#059669;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;display:inline-block;" rel="noopener">${escapeHtml(ctaLabel)}</a></p>`
    : "";

  const html = `<!doctype html><html dir="${dir}" lang="${locale}"><body style="font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;background:#f6f7f9;padding:24px;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:28px;">
  <h1 style="font-size:18px;margin:0 0 16px;">${escapeHtml(subject)}</h1>
  ${bodyHtml}
  ${ctaHtml}
  <p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:18px;">${escapeHtml(messagesFor(locale).notifications.emailFooter)}</p>
</div>
</body></html>`;

  return { subject, text, html };
}

/**
 * Analytics — Prompt 25 §49-§55/§101-§108/§172.
 *
 * A deliberately MINIMAL, first-party conversion-event model. No third-party
 * scripts, no tracking cookies (§108/§134), no data warehouse (§105).
 *
 * Hard rules enforced HERE (not by callers):
 * - ONLY the names in ANALYTICS_EVENTS can ever be written — the registry
 *   is the single place event names exist (§101); components never scatter
 *   raw strings.
 * - Lifecycle-critical events (signup/business/trial/checkout/first-*)
 *   are SERVER-GENERATED only (§55/§104). The public ingest endpoint
 *   (POST /api/v1/public/analytics) accepts ONLY the CLIENT_EVENTS subset.
 * - Properties are restricted to the safe funnel dimensions of §103:
 *   planCode, billingPeriod, currency, page, source, locale. Any other
 *   property is DROPPED. No passwords, payment credentials, customer PII,
 *   financial amounts or raw AI content ever reach this table (§50/§107).
 * - dedupeKey gives idempotency: server lifecycle events are once-ever per
 *   subject (unique index), client events dedupe per session per UTC day
 *   (§54) so React re-renders cannot spam the funnel.
 * - trackServerEvent NEVER throws and NEVER blocks the main flow: analytics
 *   must not be able to fail a signup, a sale or a payment (fire-and-forget
 *   with an awaited write so serverless workers do not drop it, but every
 *   error swallowed).
 */

// ---------------------------------------------------------------------------
// Event registry (§101/§102) — machine-readable, centralized.
// ---------------------------------------------------------------------------

export const ANALYTICS_EVENTS = [
  // Public funnel (client-generated through the allowlisted ingest API).
  "PRICING_VIEWED",
  "PLAN_SELECTED",
  "SIGNUP_STARTED",
  "ONBOARDING_STARTED",
  // Lifecycle (server-generated ONLY — §55/§104).
  "SIGNUP_COMPLETED",
  "BUSINESS_CREATED",
  "ONBOARDING_COMPLETED",
  "TRIAL_STARTED",
  "CHECKOUT_STARTED",
  "CHECKOUT_COMPLETED",
  "PAYMENT_FAILED",
  "FIRST_CUSTOMER_CREATED",
  "FIRST_PRODUCT_CREATED",
  "FIRST_SALE_CREATED",
  "COPILOT_FIRST_QUESTION",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

const EVENT_NAMES_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENTS);

/** The ONLY names the public ingest endpoint accepts (§104). */
export const CLIENT_EVENTS: readonly AnalyticsEventName[] = [
  "PRICING_VIEWED",
  "PLAN_SELECTED",
  "SIGNUP_STARTED",
  "ONBOARDING_STARTED",
];

const CLIENT_EVENTS_SET: ReadonlySet<string> = new Set(CLIENT_EVENTS);

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === "string" && EVENT_NAMES_SET.has(value);
}

export function isClientEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === "string" && CLIENT_EVENTS_SET.has(value);
}

// ---------------------------------------------------------------------------
// Safe property model (§103) — bounded, allowlisted, nothing else stored.
// ---------------------------------------------------------------------------

export type AnalyticsProps = {
  planCode?: string;
  billingPeriod?: string;
  currency?: string;
  page?: string;
  source?: string;
  locale?: string;
};

const MAX_PROP_LEN = 64;

function safeProp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PROP_LEN) return null;
  return trimmed.slice(0, MAX_PROP_LEN);
}

function sanitizeProps(input: unknown): AnalyticsProps {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: AnalyticsProps = {};
  const planCode = safeProp(raw.planCode);
  const billingPeriod = safeProp(raw.billingPeriod);
  const currency = safeProp(raw.currency);
  const page = safeProp(raw.page);
  const source = safeProp(raw.source);
  const locale = safeProp(raw.locale);
  // planCode/billingPeriod/currency get FORMAT checks — a forged value must
  // never pollute funnel dimensions (§104).
  if (planCode && /^[A-Z0-9_]{1,32}$/.test(planCode)) out.planCode = planCode;
  if (billingPeriod && ["MONTHLY", "YEARLY"].includes(billingPeriod)) {
    out.billingPeriod = billingPeriod;
  }
  if (currency && /^[A-Za-z]{3}$/.test(currency)) out.currency = currency.toUpperCase();
  if (page) out.page = page;
  if (source) out.source = source;
  if (locale && ["en", "fa"].includes(locale)) out.locale = locale;
  return out;
}

/** Public-ingest surface: same sanitizer, explicit name for clarity (§104). */
export function sanitizeClientProps(input: unknown): AnalyticsProps {
  return sanitizeProps(input);
}

// ---------------------------------------------------------------------------
// Server-side tracking (authoritative lifecycle events)
// ---------------------------------------------------------------------------

export type ServerEventInput = {
  name: AnalyticsEventName;
  userId?: string | null;
  businessId?: string | null;
  props?: AnalyticsProps;
  /** Deterministic idempotency key — the SAME subject never records twice. */
  dedupeKey?: string | null;
};

export async function trackServerEvent(input: ServerEventInput): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    await db.analyticsEvent.create({
      data: {
        name: input.name,
        userId: input.userId ?? null,
        businessId: input.businessId ?? null,
        ...sanitizeProps(input.props),
        dedupeKey: input.dedupeKey ?? null,
      },
    });
  } catch (error) {
    // Unique-violation = the dedupeKey already recorded this subject: that
    // is SUCCESS for an idempotent event, not an error. Anything else
    // (DB hiccup) must never break the caller's flow (analytics is
    // best-effort by design, §55).
    const code = (error as { code?: string }).code;
    if (code !== "P2002") {
      console.error(`[analytics] dropped event ${input.name}:`, error);
    }
  }
}

import "server-only";
import { getPublicLegalConfig } from "@/lib/legal/public-config";
import { resolveEmailTransportConfig } from "@/lib/email/config";

/**
 * Production configuration contract — Prompt 29 §3/§4/§123.
 *
 * ONE server-side validator for production posture. Every configuration
 * value resolves to exactly one of:
 *
 *   CONFIGURED      present and valid
 *   NOT_CONFIGURED  absent (honest state — may be acceptable for optional items)
 *   INVALID         present but fails validation
 *   DISABLED        intentionally switched off by configuration (feature flags)
 *   BLOCKED         intentionally not available in this deployment posture
 *                   (e.g. production payments before legitimate enablement)
 *
 * LAWS:
 *  - Secret VALUES are never returned — statuses and short machine reasons
 *    only (§4). Passwords/tokens/merchant ids never appear in any report.
 *  - Payment variables stay in their current disabled/blocked semantics
 *    (§0.11/§177): this module REPORTS state, it never activates anything.
 *  - AI cost variables keep Prompt 26/28 semantics (§178): environment
 *    attribution + guard flags are reported; no rates are invented here.
 *  - The Prompt 27 legal config module stays the authority for public legal
 *    contacts (§101 — reuse, no duplication); this module re-exports its
 *    statuses into the same unified vocabulary.
 */

export type ConfigStatus =
  | "CONFIGURED"
  | "NOT_CONFIGURED"
  | "INVALID"
  | "DISABLED"
  | "BLOCKED";

export type ConfigEntry = {
  /** Environment variable name. */
  key: string;
  status: ConfigStatus;
  /** Mandatory for production startup (§3). */
  mandatory: boolean;
  /** Machine-readable reason; never contains values. */
  reason?: string;
};

export type ProductionConfigReport = {
  environment: "production" | "development";
  /** Mandatory production identity (§3). */
  core: {
    databaseUrl: ConfigEntry;
    nextauthSecret: ConfigEntry;
    nextauthUrl: ConfigEntry;
    appBaseUrl: ConfigEntry;
  };
  /** Public trust configuration (Prompt 27 statuses, unified vocabulary). */
  publicTrust: {
    publicBaseUrl: ConfigEntry;
    publicBaseUrlHttps: boolean;
    companyLegalName: ConfigEntry;
    supportEmail: ConfigEntry;
    privacyEmail: ConfigEntry;
    legalEmail: ConfigEntry;
    securityEmail: ConfigEntry;
  };
  /** Email transport (email/config.ts authority, unified vocabulary). */
  email: {
    status: Extract<ConfigStatus, "CONFIGURED" | "NOT_CONFIGURED" | "INVALID">;
    problem: string | null;
  };
  /** Payment configuration state (report-only; never activates). */
  payments: {
    paymentsEnabled: ConfigEntry;
    provider: ConfigEntry;
    paymentEnv: ConfigEntry;
    paymentBaseUrl: ConfigEntry;
    zarinpalMerchantId: ConfigEntry;
    /** True only when a production-mode provider is genuinely usable. */
    productionActive: boolean;
  };
  /** AI cost configuration state (Prompt 26/28 semantics preserved). */
  aiCost: {
    environment: ConfigEntry;
    guardEnabled: ConfigEntry;
    operatorToken: ConfigEntry;
  };
  /** True when every mandatory entry is CONFIGURED (startup gate, §6). */
  mandatorySatisfied: boolean;
  /** Blocking problems for production startup (§5 exit-code semantics). */
  blockingProblems: string[];
};

const URL_RE = /^https?:\/\/[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function entry(
  key: string,
  mandatory: boolean,
  validate: (v: string) => boolean,
  opts: { disabledWhenUnset?: boolean; reason?: string } = {},
): ConfigEntry {
  const raw = (process.env[key] ?? "").trim();
  if (!raw) {
    if (opts.disabledWhenUnset) return { key, status: "DISABLED", mandatory, reason: opts.reason };
    return { key, status: "NOT_CONFIGURED", mandatory, reason: opts.reason };
  }
  if (!validate(raw)) {
    return { key, status: "INVALID", mandatory, reason: opts.reason };
  }
  return { key, status: "CONFIGURED", mandatory };
}

function validAbsoluteUrl(v: string): boolean {
  if (!URL_RE.test(v)) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a SQLite DATABASE_URL without exposing it:
 * accepts file: URLs (absolute or relative path) and bare absolute paths.
 * Rejects :memory: (a production restart would silently lose every record)
 * and empty paths.
 */
function validSqliteUrl(v: string): boolean {
  const lower = v.toLowerCase();
  if (lower === ":memory:" || lower === "file::memory:") return false;
  if (lower.startsWith("file:")) {
    const path = v.slice("file:".length);
    // Strip query params like ?connection_limit=1
    const clean = path.split("?")[0];
    return clean.length > 0 && !clean.includes("\0");
  }
  if (lower.startsWith("postgresql") || lower.startsWith("mysql")) return false;
  return v.length > 0 && !v.includes("\0");
}

function boolEnv(key: string): boolean {
  return (process.env[key] ?? "").trim().toLowerCase() === "true";
}

/** Compute the full production configuration report (server-side only). */
export function getProductionConfigReport(): ProductionConfigReport {
  const isProduction = process.env.NODE_ENV === "production";

  // --- core (§3) -----------------------------------------------------------
  const databaseUrl = entry("DATABASE_URL", true, validSqliteUrl, {
    reason: "SQLITE_URL_EXPECTED",
  });
  const nextauthSecret = entry(
    "NEXTAUTH_SECRET",
    true,
    (v) => v.length >= 32,
    { reason: "SECRET_TOO_SHORT_MIN_32" },
  );
  const nextauthUrl = entry("NEXTAUTH_URL", true, validAbsoluteUrl, {
    reason: "ABSOLUTE_URL_EXPECTED",
  });
  const appBaseUrl = entry("APP_BASE_URL", false, validAbsoluteUrl, {
    reason: "ABSOLUTE_URL_EXPECTED",
  });

  const mandatorySatisfied =
    databaseUrl.status === "CONFIGURED" &&
    nextauthSecret.status === "CONFIGURED" &&
    nextauthUrl.status === "CONFIGURED";

  // --- public trust (Prompt 27 authority re-used, §101) ---------------------
  const legal = getPublicLegalConfig();
  const mapLegal = (
    e: { status: "CONFIGURED" | "NOT_CONFIGURED" | "INVALID" },
  ): ConfigEntry => ({ key: "public-legal", status: e.status, mandatory: false });

  const publicBaseUrl = mapLegal(legal.baseUrl);
  const publicBaseUrlHttps = legal.httpsOrigin;

  // --- email (email/config.ts authority, §17/§18/§100) ----------------------
  const emailCfg = resolveEmailTransportConfig();
  const email = {
    status: emailCfg.status,
    problem: emailCfg.problem,
  };

  // --- payments (report-only, §177 — never activated here) ------------------
  const paymentsEnabled = boolEnv("PAYMENTS_ENABLED");
  const providerRaw = (process.env.PAYMENT_PROVIDER ?? "").trim();
  const paymentEnvRaw = (process.env.PAYMENT_ENV ?? "").trim();
  const payments = {
    paymentsEnabled: paymentsEnabled
      ? ({ key: "PAYMENTS_ENABLED", status: "CONFIGURED", mandatory: false } as ConfigEntry)
      : ({ key: "PAYMENTS_ENABLED", status: "DISABLED", mandatory: false, reason: "INTENTIONAL_DISABLED" } as ConfigEntry),
    provider: providerRaw
      ? ({ key: "PAYMENT_PROVIDER", status: "CONFIGURED", mandatory: false } as ConfigEntry)
      : ({ key: "PAYMENT_PROVIDER", status: "NOT_CONFIGURED", mandatory: false } as ConfigEntry),
    paymentEnv: paymentEnvRaw
      ? ({ key: "PAYMENT_ENV", status: "CONFIGURED", mandatory: false } as ConfigEntry)
      : ({ key: "PAYMENT_ENV", status: "NOT_CONFIGURED", mandatory: false } as ConfigEntry),
    paymentBaseUrl: entry("PAYMENT_BASE_URL", false, validAbsoluteUrl, {
      reason: "ABSOLUTE_URL_EXPECTED",
    }),
    zarinpalMerchantId: (process.env.ZARINPAL_MERCHANT_ID ?? "").trim()
      ? ({ key: "ZARINPAL_MERCHANT_ID", status: "CONFIGURED", mandatory: false } as ConfigEntry)
      : ({ key: "ZARINPAL_MERCHANT_ID", status: "NOT_CONFIGURED", mandatory: false } as ConfigEntry),
    // Honest: no production-active provider can exist while the global
    // switch is disabled or the env is not "production".
    productionActive: paymentsEnabled && paymentEnvRaw === "production",
  };

  // --- AI cost (Prompt 26/28 semantics, §178 — no rates invented) -----------
  const aiCostEnvironment = entry("AI_COST_ENVIRONMENT", false, (v) =>
    ["TEST", "PRODUCTION"].includes(v.toUpperCase()),
  );
  const aiCost = {
    environment: aiCostEnvironment,
    guardEnabled: boolEnv("AI_COST_GUARD_ENABLED")
      ? ({ key: "AI_COST_GUARD_ENABLED", status: "CONFIGURED", mandatory: false } as ConfigEntry)
      : ({ key: "AI_COST_GUARD_ENABLED", status: "DISABLED", mandatory: false, reason: "DEFAULT_OFF" } as ConfigEntry),
    operatorToken: (process.env.AI_COST_OPERATOR_TOKEN ?? "").trim()
      ? ({ key: "AI_COST_OPERATOR_TOKEN", status: "CONFIGURED", mandatory: false } as ConfigEntry)
      : ({ key: "AI_COST_OPERATOR_TOKEN", status: "NOT_CONFIGURED", mandatory: false } as ConfigEntry),
  };

  // --- blocking problems (§5/§6) --------------------------------------------
  const blockingProblems: string[] = [];
  const mandatoryFail = (e: ConfigEntry, label: string) => {
    if (e.status === "NOT_CONFIGURED") blockingProblems.push(`${label}:NOT_CONFIGURED`);
    if (e.status === "INVALID") blockingProblems.push(`${label}:${e.reason ?? "INVALID"}`);
  };
  mandatoryFail(databaseUrl, "DATABASE_URL");
  mandatoryFail(nextauthSecret, "NEXTAUTH_SECRET");
  mandatoryFail(nextauthUrl, "NEXTAUTH_URL");
  // APP_BASE_URL: in production the reset-link base must be explicit and
  // trustworthy. If it is set but INVALID that is blocking; absent is
  // acceptable only because NEXTAUTH_URL is the documented fallback (§3
  // lists APP_BASE_URL under "when configured").
  if (appBaseUrl.status === "INVALID") blockingProblems.push("APP_BASE_URL:INVALID_ABSOLUTE_URL");
  if (isProduction) {
    // §10 — an INVALID email config is a real security-posture problem.
    if (email.status === "INVALID") blockingProblems.push(`EMAIL:${email.problem ?? "INVALID"}`);
  }

  return {
    environment: isProduction ? "production" : "development",
    core: { databaseUrl, nextauthSecret, nextauthUrl, appBaseUrl },
    publicTrust: {
      publicBaseUrl,
      publicBaseUrlHttps,
      companyLegalName: mapLegal(legal.companyLegalName),
      supportEmail: mapLegal(legal.supportEmail),
      privacyEmail: mapLegal(legal.privacyEmail),
      legalEmail: mapLegal(legal.legalEmail),
      securityEmail: mapLegal(legal.securityEmail),
    },
    email,
    payments,
    aiCost,
    mandatorySatisfied,
    blockingProblems,
  };
}

/**
 * Startup gate (§6): returns the list of blocking problems in production
 * (empty when development — dev startup is never blocked by optional config).
 */
export function startupBlockingProblems(): string[] {
  if (process.env.NODE_ENV !== "production") return [];
  const report = getProductionConfigReport();
  return report.blockingProblems;
}

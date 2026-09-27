import "server-only";

/**
 * Public legal contact configuration — Prompt 27 (§49–§52, §171–§175).
 *
 * Contact values are read from the environment AT RUNTIME (never baked into
 * client code, never hard-coded). Nothing here invents a value: a missing
 * entry is reported as NOT_CONFIGURED and the public pages render an honest
 * "not configured" state instead of a fake address (§51).
 *
 * These values are NOT secrets — they are public contact points — but they
 * are only surfaced when an operator has deliberately configured them.
 * Diagnostics never print anything beyond the status and the configured
 * value itself (which is safe: it was explicitly made public by config).
 */

export type PublicConfigStatus =
  | "CONFIGURED"
  | "NOT_CONFIGURED"
  | "INVALID";

export type PublicContactEntry = {
  key: string;
  env: string;
  status: PublicConfigStatus;
  /** Configured value, or null. Never a placeholder. */
  value: string | null;
};

export type PublicLegalConfig = {
  companyLegalName: PublicContactEntry;
  baseUrl: PublicContactEntry;
  supportEmail: PublicContactEntry;
  privacyEmail: PublicContactEntry;
  legalEmail: PublicContactEntry;
  securityEmail: PublicContactEntry;
  /** True when PUBLIC_BASE_URL is an https URL (production readiness, §88). */
  httpsOrigin: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function entry(key: string, env: string, validate: (v: string) => boolean): PublicContactEntry {
  const raw = (process.env[env] ?? "").trim();
  if (!raw) return { key, env, status: "NOT_CONFIGURED", value: null };
  if (!validate(raw)) return { key, env, status: "INVALID", value: null };
  return { key, env, status: "CONFIGURED", value: raw };
}

function validBaseUrl(v: string): boolean {
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Development may use localhost; production-shaped values must be absolute.
    return true;
  } catch {
    return false;
  }
}

/** Read the full public legal config from the current environment. */
export function getPublicLegalConfig(): PublicLegalConfig {
  const baseUrl = entry("baseUrl", "PUBLIC_BASE_URL", validBaseUrl);
  const httpsOrigin = baseUrl.status === "CONFIGURED" && baseUrl.value !== null
    ? (baseUrl.value.startsWith("https://"))
    : false;

  return {
    companyLegalName: entry("companyLegalName", "PUBLIC_COMPANY_LEGAL_NAME", (v) => v.length >= 2),
    baseUrl,
    supportEmail: entry("supportEmail", "PUBLIC_SUPPORT_EMAIL", (v) => EMAIL_RE.test(v)),
    privacyEmail: entry("privacyEmail", "PRIVACY_CONTACT_EMAIL", (v) => EMAIL_RE.test(v)),
    legalEmail: entry("legalEmail", "LEGAL_CONTACT_EMAIL", (v) => EMAIL_RE.test(v)),
    securityEmail: entry("securityEmail", "SECURITY_CONTACT_EMAIL", (v) => EMAIL_RE.test(v)),
    httpsOrigin,
  };
}

/**
 * Serializable form passed from server pages to client components.
 * Only status + the deliberately-public value cross the boundary.
 */
export type PublicLegalConfigDTO = {
  companyLegalName: string | null;
  baseUrl: string | null;
  supportEmail: string | null;
  privacyEmail: string | null;
  legalEmail: string | null;
  securityEmail: string | null;
  httpsOrigin: boolean;
};

export function publicLegalConfigDTO(): PublicLegalConfigDTO {
  const c = getPublicLegalConfig();
  const val = (e: PublicContactEntry) => (e.status === "CONFIGURED" ? e.value : null);
  return {
    companyLegalName: val(c.companyLegalName),
    baseUrl: val(c.baseUrl),
    supportEmail: val(c.supportEmail),
    privacyEmail: val(c.privacyEmail),
    legalEmail: val(c.legalEmail),
    securityEmail: val(c.securityEmail),
    httpsOrigin: c.httpsOrigin,
  };
}

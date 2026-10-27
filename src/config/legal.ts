/**
 * Legal configuration — Prompt 27 §6/§66/§67/§80/§81.
 *
 * THE single operator-editable source for legal-document metadata and
 * public contact/identity configuration. NO VALUE IS INVENTED HERE:
 *
 * - Document versions/effective dates are REAL operator-maintained values
 *   for the current release (v1.0, first public publication). When the
 *   operator updates a document, they bump `version` and the dates HERE —
 *   never in page components.
 * - Contact/identity fields come from environment variables and are NULL
 *   when unset. The UI renders a neutral fallback (the pricing-page contact
 *   form) instead of a fabricated address; the readiness script
 *   (scripts/legal-public-readiness.mjs) reports missing contact config as
 *   a PRODUCTION BLOCKER.
 * - These are PUBLIC values only — never API keys or secrets (§82).
 */

export type LegalDocKey = "privacy" | "terms" | "ai-data-use" | "trust";

export type LegalDocMeta = {
  /** Document version shown on the page (e.g. "1.0"). */
  version: string;
  /** YYYY-MM-DD — the date the document became effective. */
  effectiveDate: string;
  /** YYYY-MM-DD — the last material update. */
  lastUpdated: string;
};

/**
 * Prompt 27 §6/§73 — real values for the FIRST published revision.
 * 2026-09-25 is the actual publication date of this revision in this
 * environment; the operator updates these when documents change.
 */
export const LEGAL_DOCS: Record<LegalDocKey, LegalDocMeta> = {
  privacy: { version: "1.0", effectiveDate: "2026-09-25", lastUpdated: "2026-09-25" },
  terms: { version: "1.0", effectiveDate: "2026-09-25", lastUpdated: "2026-09-25" },
  "ai-data-use": { version: "1.0", effectiveDate: "2026-09-25", lastUpdated: "2026-09-25" },
  trust: { version: "1.0", effectiveDate: "2026-09-25", lastUpdated: "2026-09-25" },
};

/** The legal documents that are REQUIRED for public production (§86). */
export const REQUIRED_LEGAL_DOCS: readonly LegalDocKey[] = ["privacy", "terms", "ai-data-use"];

/** The closed doc-key vocabulary as a value — one source for guards. */
export const LEGAL_DOC_KEYS: readonly LegalDocKey[] = [
  "privacy",
  "terms",
  "ai-data-use",
  "trust",
];

/** Runtime guard: only closed-vocabulary doc keys ever become view state. */
export function isLegalDocKey(value: string): value is LegalDocKey {
  return (LEGAL_DOC_KEYS as readonly string[]).includes(value);
}

function envOrNull(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type LegalContacts = {
  /** Operator legal entity name (PUBLIC_COMPANY_LEGAL_NAME). */
  companyName: string | null;
  /** General support address (PUBLIC_SUPPORT_EMAIL). */
  supportEmail: string | null;
  /** Privacy contact (PRIVACY_CONTACT_EMAIL). */
  privacyEmail: string | null;
  /** Legal/terms contact (LEGAL_CONTACT_EMAIL). */
  legalEmail: string | null;
  /** Public business address (PUBLIC_BUSINESS_ADDRESS). */
  address: string | null;
  /** Governing-law jurisdiction — NEVER rendered publicly until legal review (§147). */
  jurisdiction: string | null;
};

/**
 * Reads the operator configuration at call time (not import time) so the
 * readiness script and tests can exercise configured/unconfigured states.
 */
export function getLegalContacts(): LegalContacts {
  return {
    companyName: envOrNull("PUBLIC_COMPANY_LEGAL_NAME"),
    supportEmail: envOrNull("PUBLIC_SUPPORT_EMAIL"),
    privacyEmail: envOrNull("PRIVACY_CONTACT_EMAIL"),
    legalEmail: envOrNull("LEGAL_CONTACT_EMAIL"),
    address: envOrNull("PUBLIC_BUSINESS_ADDRESS"),
    jurisdiction: envOrNull("LEGAL_JURISDICTION"),
  };
}

/**
 * True when the operator identity (legal name) is configured. Public pages
 * render neutral product-level wording when it is not — never a placeholder.
 */
export function hasOperatorIdentity(): boolean {
  return getLegalContacts().companyName !== null;
}

/** True when every contact channel required for production is configured. */
export function hasRequiredContacts(): boolean {
  const c = getLegalContacts();
  return c.privacyEmail !== null && c.legalEmail !== null && c.supportEmail !== null;
}

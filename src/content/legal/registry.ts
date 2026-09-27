/**
 * Legal documents registry — Prompt 27 (§30/§31).
 *
 * Single source of truth for the public legal documents. The register is
 * consumed by:
 *  - the public pages (/privacy /terms /ai-data-use /cookies),
 *  - the acceptance API (server resolves the CURRENT version — the client
 *    is never trusted with version authority, §163),
 *  - the documents metadata endpoint (only documentType/version/locale/
 *    effectiveDate/lastUpdated leave the boundary, §161),
 *  - the readiness/review scripts (bun imports this module directly).
 */

import type { LegalDocType, LegalDocument, LegalLocale } from "./types";
import { privacyDoc } from "./privacy";
import { termsDoc } from "./terms";
import { aiDataUseDoc } from "./ai-data-use";
import { cookiesDoc } from "./cookies";

export const LEGAL_DOCUMENTS: Record<LegalDocType, LegalDocument> = {
  privacy: privacyDoc,
  terms: termsDoc,
  "ai-data-use": aiDataUseDoc,
  cookies: cookiesDoc,
};

export const LEGAL_DOC_TYPES: LegalDocType[] = [
  "privacy",
  "terms",
  "ai-data-use",
  "cookies",
];

/** Document types a signing-up user accepts (cookies is informational). */
export const ACCEPTED_DOC_TYPES: LegalDocType[] = ["privacy", "terms"];

export function getLegalDocument(type: LegalDocType): LegalDocument {
  return LEGAL_DOCUMENTS[type];
}

/** Current version map — the acceptance API resolves versions from here. */
export function currentLegalVersions(): Record<LegalDocType, string> {
  return {
    privacy: LEGAL_DOCUMENTS.privacy.version,
    terms: LEGAL_DOCUMENTS.terms.version,
    "ai-data-use": LEGAL_DOCUMENTS["ai-data-use"].version,
    cookies: LEGAL_DOCUMENTS.cookies.version,
  };
}

/** Route path for a document type (stable URLs — never version-scoped, §222). */
export function legalRoutePath(type: LegalDocType): string {
  return type === "ai-data-use" ? "/ai-data-use" : `/${type}`;
}

export function isLegalDocType(value: unknown): value is LegalDocType {
  return (
    typeof value === "string" && LEGAL_DOC_TYPES.includes(value as LegalDocType)
  );
}

export function isLegalLocale(value: unknown): value is LegalLocale {
  return value === "en" || value === "fa";
}

export type { LegalDocType, LegalDocument, LegalLocale };

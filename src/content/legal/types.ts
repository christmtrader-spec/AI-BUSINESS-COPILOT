/**
 * Legal content model — Prompt 27 (§30/§31/§32).
 *
 * Structured, locale-paired legal documents. Legal copy lives HERE, never
 * scattered through React components and never duplicated as a second
 * hard-coded Persian page (§29). Rendering components consume this shape
 * generically so every document gets identical layout, TOC, RTL, theming
 * and print behaviour.
 *
 * Honesty law (§219/§220/§264):
 *  - `version` is a deterministic string ("2026-09-v1"), never a UUID.
 *  - `effectiveDate` is null until deliberately configured — the UI shows an
 *    honest "not configured" state instead of silently using today().
 *  - `lastUpdated` records when the CONTENT was authored/revised (factual).
 *  - `legalReviewRequired` is an INTERNAL marker (never rendered publicly):
 *    the documents are technically grounded but have not been reviewed by
 *    qualified counsel (§140/§264).
 */

export type LegalLocale = "en" | "fa";

export const LEGAL_LOCALES: LegalLocale[] = ["en", "fa"];

export type LegalDocType = "privacy" | "terms" | "ai-data-use" | "cookies";

export type LegalBlock =
  | { kind: "p"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

export type LegalSection = {
  /** Stable anchor id (TOC + deep links). Never translated. */
  id: string;
  title: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  type: LegalDocType;
  /** Deterministic version id. New content revision → new version (§55/§220). */
  version: string;
  /** ISO date or null = EFFECTIVE DATE NOT CONFIGURED (§219). */
  effectiveDate: string | null;
  /** ISO date of the last content revision (factual authoring date). */
  lastUpdated: string;
  /** Internal only — never rendered on public pages (§139/§264). */
  legalReviewRequired: boolean;
  locales: Record<LegalLocale, { title: string; description: string; sections: LegalSection[] }>;
};

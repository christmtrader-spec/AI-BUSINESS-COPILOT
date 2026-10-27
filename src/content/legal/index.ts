/**
 * Legal content registry — Prompt 27 §7/§83/§84.
 * The ONE place documents are registered; the LegalView, the readiness
 * script and the prompt-27 harness all consume this module.
 */

import type { LegalDocKey } from "@/config/legal";
import type { LegalDocumentContent } from "./types";
import { privacyContent } from "./privacy-content";
import { termsContent } from "./terms-content";
import { aiDataUseContent } from "./ai-data-use-content";
import { trustContent } from "./trust";

export type { LegalDocumentContent, LocalizedText, LocalizedLegalSection } from "./types";

export const LEGAL_CONTENT: Record<LegalDocKey, LegalDocumentContent> = {
  privacy: privacyContent,
  terms: termsContent,
  "ai-data-use": aiDataUseContent,
  trust: trustContent,
};

export function getLegalDocument(key: LegalDocKey): LegalDocumentContent {
  return LEGAL_CONTENT[key];
}

/** True when every section of a document carries BOTH locales non-empty. */
export function isDocumentComplete(doc: LegalDocumentContent): boolean {
  const filled = (t: { en: string; fa: string } | undefined): boolean =>
    !!t && t.en.trim().length > 0 && t.fa.trim().length > 0;
  if (!filled(doc.title)) return false;
  if (!doc.intro.every(filled)) return false;
  return doc.sections.every(
    (s) => filled(s.heading) && (s.paragraphs ?? []).every(filled) && (s.bullets ?? []).every(filled),
  );
}

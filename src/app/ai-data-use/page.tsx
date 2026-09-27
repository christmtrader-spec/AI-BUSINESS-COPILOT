import type { Metadata } from "next";
import { LegalDocRoot } from "@/components/legal/legal-doc-root";
import { publicLegalConfigDTO } from "@/lib/legal/public-config";
import { LEGAL_DOCUMENTS } from "@/content/legal/registry";

/**
 * /ai-data-use — public AI Data Use page (Prompt 27 §35).
 * Explains plainly what AI features do, what data may be supplied, what is
 * stored, what is sent to third-party providers, limitations and controls.
 * No provider API secrets, no provider cost, no internal system prompt.
 */

const doc = LEGAL_DOCUMENTS["ai-data-use"];

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: doc.locales.en.title,
  description: doc.locales.en.description,
  alternates: { canonical: "/ai-data-use" },
  robots: { index: true, follow: true },
};

export default function AiDataUsePage() {
  return <LegalDocRoot docType="ai-data-use" config={publicLegalConfigDTO()} />;
}

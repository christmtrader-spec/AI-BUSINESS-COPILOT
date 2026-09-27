import type { Metadata } from "next";
import { LegalDocRoot } from "@/components/legal/legal-doc-root";
import { publicLegalConfigDTO } from "@/lib/legal/public-config";
import { LEGAL_DOCUMENTS } from "@/content/legal/registry";

/**
 * /terms — public Terms of Service (Prompt 27 §28).
 * Accessible without authentication (§236). force-dynamic for predictable
 * version/contact updates without a build (§65/§148/§174).
 */

const doc = LEGAL_DOCUMENTS.terms;

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: doc.locales.en.title,
  description: doc.locales.en.description,
  alternates: { canonical: "/terms" },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return <LegalDocRoot docType="terms" config={publicLegalConfigDTO()} />;
}

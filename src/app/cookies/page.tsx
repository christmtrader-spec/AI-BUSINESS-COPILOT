import type { Metadata } from "next";
import { LegalDocRoot } from "@/components/legal/legal-doc-root";
import { publicLegalConfigDTO } from "@/lib/legal/public-config";
import { LEGAL_DOCUMENTS } from "@/content/legal/registry";

/**
 * /cookies — public Cookie Policy (Prompt 27 §47).
 * Created because the service genuinely uses non-essential cookies
 * (a first-party analytics key + a UI preference cookie) and documents them
 * with their actual names and attributes. No consent banner exists because
 * there is no third-party tracking to consent to (§46/§48).
 */

const doc = LEGAL_DOCUMENTS.cookies;

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: doc.locales.en.title,
  description: doc.locales.en.description,
  alternates: { canonical: "/cookies" },
  robots: { index: true, follow: true },
};

export default function CookiesPage() {
  return <LegalDocRoot docType="cookies" config={publicLegalConfigDTO()} />;
}

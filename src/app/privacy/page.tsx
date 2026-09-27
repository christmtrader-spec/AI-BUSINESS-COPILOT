import type { Metadata } from "next";
import { LegalDocRoot } from "@/components/legal/legal-doc-root";
import { publicLegalConfigDTO } from "@/lib/legal/public-config";
import { LEGAL_DOCUMENTS } from "@/content/legal/registry";

/**
 * /privacy — public Privacy Policy (Prompt 27 §28).
 * Accessible without authentication (§236). force-dynamic so a new policy
 * version and reconfigured contacts appear without a build (§65/§148/§174).
 */

const doc = LEGAL_DOCUMENTS.privacy;

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: doc.locales.en.title,
  description: doc.locales.en.description,
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return <LegalDocRoot docType="privacy" config={publicLegalConfigDTO()} />;
}

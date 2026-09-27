"use client";

/**
 * Legal document root — Prompt 27 (§28/§29).
 *
 * The legal routes live OUTSIDE the authenticated app shell but share the
 * SAME locale + theme infrastructure as /pricing (persisted store,
 * next-themes, next-intl), so EN/FA + LTR/RTL + dark/light behave
 * identically. No session, no tenant data, no tracking beyond the
 * documented first-party cookies.
 */

import { useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { NextIntlClientProvider } from "next-intl";
import { useAppStore } from "@/store/app-store";
import { messagesFor } from "@/i18n/messages";
import { dirOf } from "@/i18n/config";
import { LegalDocView } from "@/components/legal/legal-doc-view";
import type { LegalDocType } from "@/content/legal/types";
import type { PublicLegalConfigDTO } from "@/lib/legal/public-config";

export function LegalDocRoot({
  docType,
  config,
}: {
  docType: LegalDocType;
  config: PublicLegalConfigDTO;
}) {
  const locale = useAppStore((s) => s.locale);

  // Drive <html> lang/dir from the active locale (same contract as app-root).
  useEffect(() => {
    document.documentElement.dir = dirOf(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <NextIntlClientProvider locale={locale} messages={messagesFor(locale)} timeZone="UTC">
        <LegalDocView docType={docType} config={config} />
      </NextIntlClientProvider>
    </ThemeProvider>
  );
}

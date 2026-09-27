"use client";

/**
 * Public pricing root — Prompt 25.
 *
 * The /pricing route is intentionally OUTSIDE the authenticated app shell,
 * but shares the SAME locale + theme infrastructure (persisted store,
 * next-themes, next-intl) so EN/FA + LTR/RTL + dark/light behave identically
 * to the app. No session, no business data, no internal pricing state.
 */

import { useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { NextIntlClientProvider } from "next-intl";
import { useAppStore } from "@/store/app-store";
import { messagesFor } from "@/i18n/messages";
import { dirOf } from "@/i18n/config";
import { PricingPublicView } from "@/components/public/pricing-view";

export function PricingRoot() {
  const locale = useAppStore((s) => s.locale);

  // Drive <html> lang/dir from the active locale (same contract as app-root).
  useEffect(() => {
    document.documentElement.dir = dirOf(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <NextIntlClientProvider locale={locale} messages={messagesFor(locale)} timeZone="UTC">
        <PricingPublicView />
      </NextIntlClientProvider>
    </ThemeProvider>
  );
}

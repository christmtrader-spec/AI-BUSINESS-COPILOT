"use client";

import { useState, type ReactNode } from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { useAppStore } from "@/store/app-store";
import { messagesFor } from "@/i18n/messages";

function IntlBoundary({ children }: { children: ReactNode }) {
  const locale = useAppStore((s) => s.locale);
  return (
    <NextIntlClientProvider locale={locale} messages={messagesFor(locale)} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 15_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <SessionProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <QueryClientProvider client={queryClient}>
          <IntlBoundary>{children}</IntlBoundary>
        </QueryClientProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}

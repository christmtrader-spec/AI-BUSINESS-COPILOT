"use client";

/**
 * Legal document view — Prompt 27 (§28/§66/§67/§93/§94/§95/§233/§234).
 *
 * Generic renderer for the structured legal content layer:
 *  - section navigation (TOC) with anchor links — keyboard accessible;
 *  - version/last-updated/effective-date metadata from the document model;
 *  - honest contact panel driven by the live public configuration (§51);
 *  - per-section error boundary — one malformed section never crashes the
 *    whole page (§234);
 *  - print-friendly (header/TOC hidden in print, content kept) (§95);
 *  - no client-only dates: all dates are pre-authored strings formatted
 *    deterministically from the document model (§233);
 *  - no raw HTML is ever rendered — structured blocks only (§98).
 */

import { Component, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useTheme } from "next-themes";
import { FileText, Globe, List, Moon, Printer, Sparkles, Sun } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PublicFooter } from "@/components/public/public-footer";
import { LEGAL_DOCUMENTS } from "@/content/legal/registry";
import type { LegalBlock, LegalDocType, LegalSection } from "@/content/legal/types";
import type { PublicLegalConfigDTO } from "@/lib/legal/public-config";

/** Per-section error boundary (§234). */
class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <p className="text-destructive text-sm">—</p>;
    }
    return this.props.children;
  }
}

function formatDateIso(iso: string, locale: string): string {
  // `locale` arrives already resolved ("fa-IR" | "en-US") — use it directly
  // (a re-derivation here would fall back to en-US for the fa-IR input).
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso;
  }
}

function Block({ block }: { block: LegalBlock }) {
  if (block.kind === "p") {
    return <p className="text-foreground/90 leading-7">{block.text}</p>;
  }
  if (block.kind === "bullets") {
    return (
      <ul className="text-foreground/90 list-disc space-y-2 ps-6 leading-7 marker:text-muted-foreground">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            {block.head.map((h, i) => (
              <th key={i} scope="col" className="text-start font-semibold px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-b last:border-0">
              {row.map((cell, c) => (
                <td key={c} className="px-3 py-2 align-top leading-6">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionBody({ section }: { section: LegalSection }) {
  return (
    <div className="space-y-4">
      {section.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

export function LegalDocView({
  docType,
  config,
}: {
  docType: LegalDocType;
  config: PublicLegalConfigDTO;
}) {
  const t = useTranslations("legal.doc");
  const tFooter = useTranslations("legal.footer");
  const tCommon = useTranslations("common");
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const { resolvedTheme, setTheme } = useTheme();

  const doc = LEGAL_DOCUMENTS[docType];
  const content = doc.locales[locale];
  const dateLocale = locale === "fa" ? "fa-IR" : "en-US";

  const contactRows: Array<{ label: string; value: string | null; mailto: string | null }> = [
    { label: t("contact.company"), value: config.companyLegalName, mailto: null },
    {
      label: t("contact.privacy"),
      value: config.privacyEmail,
      mailto: config.privacyEmail ? `mailto:${config.privacyEmail}` : null,
    },
    {
      label: t("contact.legal"),
      value: config.legalEmail,
      mailto: config.legalEmail ? `mailto:${config.legalEmail}` : null,
    },
    {
      label: t("contact.support"),
      value: config.supportEmail,
      mailto: config.supportEmail ? `mailto:${config.supportEmail}` : null,
    },
    {
      label: t("contact.security"),
      value: config.securityEmail,
      mailto: config.securityEmail ? `mailto:${config.securityEmail}` : null,
    },
  ];

  return (
    <div className="bg-background text-foreground flex min-h-svh flex-col" data-view={`legal:${docType}`}>
      {/* Skip link (§93 accessibility) */}
      <a
        href="#legal-content"
        className="bg-primary text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-2"
      >
        {tCommon("skipToContent")}
      </a>
      {/* Header — hidden in print */}
      <header className="bg-background/80 sticky top-0 z-20 border-b backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Sparkles className="text-primary size-5" aria-hidden="true" />
            <span className="gradient-text">{tCommon("appName")}</span>
          </Link>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-label={locale === "fa" ? "English" : "فارسی"}
              onClick={() => setLocale(locale === "fa" ? "en" : "fa")}
            >
              <Globe className="size-4" aria-hidden="true" />
              {locale === "fa" ? "EN" : "فا"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("toggleTheme")}
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? (
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
            </Button>
            <Button asChild size="sm">
              <a href="/">{t("openApp")}</a>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        {/* Document header */}
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1.5">
              <FileText className="size-3.5" aria-hidden="true" />
              {t("version", { version: doc.version })}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {t("lastUpdated", { date: formatDateIso(doc.lastUpdated, dateLocale) })}
            </span>
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{content.title}</h1>
          <p className="text-muted-foreground mt-3 text-base">{content.description}</p>
          <p className="text-muted-foreground mt-2 text-sm">
            {doc.effectiveDate
              ? t("effectiveDate", { date: formatDateIso(doc.effectiveDate, dateLocale) })
              : t("effectiveDateNotConfigured")}
          </p>
        </div>

        <div className="mt-10 flex gap-10">
          {/* TOC — sticky sidebar on large screens */}
          <nav
            aria-label={t("onThisPage")}
            className="hidden w-60 shrink-0 print:hidden xl:block"
          >
            <div className="sticky top-24">
              <p className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
                <List className="size-3.5" aria-hidden="true" />
                {t("onThisPage")}
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {content.sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="text-muted-foreground hover:text-foreground block rounded px-2 py-1 underline-offset-4 hover:underline"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 w-full"
                onClick={() => window.print()}
              >
                <Printer className="size-4" aria-hidden="true" />
                {t("print")}
              </Button>
            </div>
          </nav>

          {/* Sections */}
          <article id="legal-content" className="min-w-0 max-w-3xl flex-1 space-y-10">
            {/* Mobile TOC */}
            <nav
              aria-label={t("onThisPage")}
              className="border-border rounded-lg border p-4 print:hidden xl:hidden"
            >
              <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                {t("onThisPage")}
              </p>
              <ul className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                {content.sections.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className="hover:text-foreground underline-offset-4 hover:underline">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            {content.sections.map((section, idx) => (
              <SectionBoundary key={section.id}>
                <section id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-24">
                  <h2 id={`${section.id}-title`} className="text-xl font-semibold tracking-tight sm:text-2xl">
                    {section.title}
                  </h2>
                  <div className="mt-4">
                    <SectionBody section={section} />
                  </div>
                  {idx === content.sections.length - 1 ? null : (
                    <Separator className="mt-10" />
                  )}
                </section>
              </SectionBoundary>
            ))}

            {/* Configuration-driven contact panel (§50/§51) — complements the
                document's Contact section with the LIVE configured values. */}
            <section id="contact-details" aria-labelledby="contact-details-title" className="scroll-mt-24">
              <h2 id="contact-details-title" className="text-xl font-semibold tracking-tight sm:text-2xl">
                {t("contact.title")}
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">{t("contact.note")}</p>
              <dl className="border-border mt-4 divide-y rounded-lg border">
                {contactRows.map((row) => (
                  <div key={row.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <dt className="font-medium">{row.label}</dt>
                    <dd>
                      {row.value ? (
                        row.mailto ? (
                          <a href={row.mailto} className="text-primary underline-offset-4 hover:underline">
                            {row.value}
                          </a>
                        ) : (
                          row.value
                        )
                      ) : (
                        <span className="text-muted-foreground italic">{t("contact.notConfigured")}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </article>
        </div>
      </main>

      <PublicFooter companyName={config.companyLegalName} notes={[tFooter("honestNote")]} />
    </div>
  );
}

"use client";

/**
 * LegalView — Prompt 27 §4/§6/§73/§74/§75/§76/§77/§83/§84/§128/§158.
 *
 * Renders ONE legal/trust document from the structured content layer
 * (src/content/legal — never text embedded in components). Works in two
 * modes through the SAME component, mirroring PricingView:
 *  - public (unauthenticated): standalone page with its own header/footer
 *    at #/privacy, #/terms, #/ai-data-use, #/trust;
 *  - in-app (authenticated): the same body rendered inside the shell.
 *
 * Honesty invariants:
 * - Version / effective date / last-updated come from src/config/legal.ts
 *   (§6 — operator-updatable source; never hard-coded in JSX).
 * - Contact section renders ONLY configured emails (§66/§79/§150). When
 *   nothing is configured, it falls back to the REAL channel that exists
 *   today — the pricing-page contact form. No fake addresses, ever.
 * - No internal markers (LEGAL_REVIEW_REQUIRED etc.) leak into public copy
 *   (§87/§164) — the operator-facing readiness script reports those.
 * - Error state (§158): a safe neutral fallback, never undefined/TBD.
 */

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { FileText, Scale, ShieldCheck, Sparkles } from "lucide-react";
import { useAppStore, type LegalDocKey } from "@/store/app-store";
import { getLegalContacts, LEGAL_DOCS } from "@/config/legal";
import { LEGAL_CONTENT, type LocalizedText } from "@/content/legal";
import { Button } from "@/components/ui/button";
import { LocaleSwitcher, ThemeToggle } from "@/modules/shell/header";

const DOC_ICONS: Record<LegalDocKey, typeof ShieldCheck> = {
  privacy: ShieldCheck,
  terms: Scale,
  "ai-data-use": Sparkles,
  trust: FileText,
};

/** Pick the localized variant of a content node (both locales verified). */
function tx(text: LocalizedText, locale: string): string {
  return locale === "fa" ? text.fa : text.en;
}

/**
 * Doc key → i18n seo key. The doc key "ai-data-use" is kebab-case, the
 * message key is camelCase — BUGFIX #24 (raw key leaked into document.title).
 */
function seoKeyFor(doc: LegalDocKey): "seo.privacy" | "seo.terms" | "seo.aiDataUse" | "seo.trust" {
  switch (doc) {
    case "privacy":
      return "seo.privacy";
    case "terms":
      return "seo.terms";
    case "ai-data-use":
      return "seo.aiDataUse";
    case "trust":
      return "seo.trust";
  }
}

/** The contact emails shown for each document (null → fallback sentence). */
function contactEmailsFor(doc: LegalDocKey): string[] {
  const c = getLegalContacts();
  const emails: string[] = [];
  if (doc === "privacy" && c.privacyEmail) emails.push(c.privacyEmail);
  if (doc === "terms" && c.legalEmail) emails.push(c.legalEmail);
  if (doc === "trust" && c.supportEmail) emails.push(c.supportEmail);
  if (doc === "ai-data-use" && (c.privacyEmail ?? c.supportEmail)) {
    emails.push((c.privacyEmail ?? c.supportEmail) as string);
  }
  return emails;
}

export function LegalView({ doc }: { doc: LegalDocKey }) {
  const t = useTranslations("legal");
  const tCommon = useTranslations("common");
  const tPricing = useTranslations("pricing");
  const { status } = useSession();
  const authenticated = status === "authenticated";
  const locale = useAppStore((s) => s.locale);
  const navigate = useAppStore((s) => s.navigate);
  const setAuthMode = useAppStore((s) => s.setAuthMode);

  const content = LEGAL_CONTENT[doc];
  const meta = LEGAL_DOCS[doc];
  const DocIcon = DOC_ICONS[doc];

  // Prompt 27 §125 — factual per-document SEO title (public mode only; the
  // in-app shell owns the title). A meta description is kept in sync so the
  // document is describable without exposing sensitive metadata.
  useEffect(() => {
    if (authenticated) return;
    document.title = t(seoKeyFor(doc));
    const description = tx(content.intro[0], locale);
    if (description) {
      let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
      if (!tag) {
        tag = document.createElement("meta");
        tag.name = "description";
        document.head.appendChild(tag);
      }
      tag.content = description;
    }
    // Leaving the document (e.g. → sign-in) must not keep a stale legal title.
    return () => {
      document.title = tCommon("appName");
    };
  }, [authenticated, doc, t, tCommon, content, locale]);
  /** Navigate to another public page (hash router — deep-linkable). */
  function goTo(docKey: LegalDocKey | "pricing") {
    if (docKey === "pricing") {
      navigate({ kind: "pricing" });
    } else {
      navigate({ kind: "legal", doc: docKey });
    }
  }

  const contactEmails = contactEmailsFor(doc);

  return (
    <div className="bg-background flex min-h-svh flex-col" data-view={`legal-${doc}`}>
      {/* Header — same visual language as the public pricing header */}
      <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            className="flex items-center gap-2.5"
            onClick={() => {
              if (!authenticated) setAuthMode("signin");
              navigate({ kind: "dashboard" });
            }}
            aria-label={tCommon("appName")}
          >
            <span className="bg-background flex size-9 items-center justify-center rounded-xl border shadow-sm">
              <img src="/logo.svg" alt="" className="size-5" aria-hidden="true" />
            </span>
            <span className="text-start">
              <span className="gradient-text block text-sm font-semibold leading-tight">
                {tCommon("appName")}
              </span>
              <span className="text-muted-foreground block text-xs leading-tight">
                {tCommon("tagline")}
              </span>
            </span>
          </button>
          <div className="flex items-center gap-1.5">
            <LocaleSwitcher />
            <ThemeToggle />
            {authenticated ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAuthMode("signin");
                  navigate({ kind: "dashboard" });
                }}
              >
                {tPricing("nav.signIn")}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Title block */}
        <section className="from-primary/5 via-primary/10 to-primary/5 border-b bg-gradient-to-b">
          <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-10 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="bg-background text-primary flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm">
                <DocIcon className="size-5" aria-hidden="true" />
              </span>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {tx(content.title, locale)}
              </h1>
            </div>
            {/* §6/§73 — version + dates from the operator config source */}
            <ul className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <li className="bg-background rounded-full border px-2.5 py-0.5">
                {t("meta.version", { version: meta.version })}
              </li>
              <li>{t("meta.effective", { date: meta.effectiveDate })}</li>
              <li>{t("meta.updated", { date: meta.lastUpdated })}</li>
            </ul>
            <p className="text-muted-foreground max-w-2xl text-sm">{t("meta.draft")}</p>
          </div>
        </section>

        {/* Body */}
        <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
          <div className="gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_220px]">
            <article className="min-w-0 space-y-8" data-legal-body={doc}>
              {/* Intro */}
              <div className="space-y-3">
                {content.intro.map((p, i) => (
                  <p key={i} className="text-foreground/90 text-sm leading-relaxed sm:text-base">
                    {tx(p, locale)}
                  </p>
                ))}
              </div>

              {/* Sections (§74 — semantic headings, anchor ids) */}
              {content.sections.map((section) => (
                <section key={section.id} aria-labelledby={`${doc}-${section.id}`} className="scroll-mt-24 space-y-3">
                  <h2 id={`${doc}-${section.id}`} className="text-lg font-semibold tracking-tight sm:text-xl">
                    {tx(section.heading, locale)}
                  </h2>
                  {(section.paragraphs ?? []).map((p, i) => (
                    <p key={i} className="text-muted-foreground text-sm leading-relaxed">
                      {tx(p, locale)}
                    </p>
                  ))}
                  {(section.bullets ?? []).length > 0 ? (
                    <ul className="text-muted-foreground space-y-2.5 text-sm leading-relaxed">
                      {(section.bullets ?? []).map((b, i) => (
                        <li key={i} className="flex gap-2.5">
                          <span className="bg-primary/15 text-primary mt-2 size-1.5 shrink-0 rounded-full" aria-hidden="true" />
                          <span>{tx(b, locale)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {/* §66/§150 — the contact block: configured channels only */}
                  {section.id === "contact" ? (
                    <div className="bg-muted/40 space-y-2 rounded-lg border p-4 text-sm">
                      {contactEmails.length > 0 ? (
                        contactEmails.map((email) => (
                          <p key={email} className="flex flex-wrap items-center gap-2">
                            <span className="text-muted-foreground">{t("contact.emailLabel")}:</span>
                            <a
                              href={`mailto:${email}`}
                              dir="ltr"
                              className="text-primary font-medium underline-offset-4 hover:underline"
                            >
                              {email}
                            </a>
                          </p>
                        ))
                      ) : (
                        <p className="text-muted-foreground">{t("contact.fallback")}</p>
                      )}
                      {contactEmails.length === 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => goTo("pricing")}
                        >
                          {t("nav.pricing")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ))}
            </article>

            {/* On-this-page navigation (§74 — keyboard-accessible anchors) */}
            <nav aria-label={t("toc.title")} className="hidden lg:block">
              <div className="sticky top-20 space-y-2">
                <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  {t("toc.title")}
                </p>
                <ul className="space-y-1.5">
                  {content.sections.map((section) => (
                    <li key={section.id}>
                      <a
                        href={`#${doc}-${section.id}`}
                        className="text-muted-foreground hover:text-foreground block rounded px-2 py-1 text-xs leading-snug underline-offset-4 hover:underline"
                      >
                        {tx(section.heading, locale)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          </div>
        </div>
      </main>

      {/* Footer (§68/§128 — every real destination, cross-linked) */}
      <footer className="mt-auto border-t">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-between gap-3 px-4 py-5 text-xs sm:flex-row sm:px-6">
          <nav aria-label={tCommon("appName")} className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
            {doc !== "privacy" ? (
              <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => goTo("privacy")}>
                {t("nav.privacy")}
              </button>
            ) : null}
            {doc !== "terms" ? (
              <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => goTo("terms")}>
                {t("nav.terms")}
              </button>
            ) : null}
            {doc !== "ai-data-use" ? (
              <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => goTo("ai-data-use")}>
                {t("nav.aiDataUse")}
              </button>
            ) : null}
            {doc !== "trust" ? (
              <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => goTo("trust")}>
                {t("nav.trust")}
              </button>
            ) : null}
            <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => goTo("pricing")}>
              {t("nav.pricing")}
            </button>
          </nav>
          <p className="text-muted-foreground/80">{t("footer.note")}</p>
        </div>
      </footer>
    </div>
  );
}

"use client";

/**
 * PricingView — Prompt 25 §1/§4-§29/§56-§83/§111-§119/§126-§141/§149-§153.
 *
 * The PUBLIC pricing experience, rendered from ONE catalog endpoint
 * (GET /api/v1/public/pricing — the PricingService underneath, §136). Works
 * in two modes through the SAME component:
 *  - public  (unauthenticated): standalone page with its own header/footer;
 *  - in-app  (authenticated): rendered inside the shell; CTAs navigate to
 *    the existing billing flow — this view NEVER mutates a subscription
 *    (§120/§25) and never shows private usage (§13/§141).
 *
 * Honesty invariants:
 * - EVERY amount comes from the payload (amountMinor + currency metadata,
 *   formatted through formatMinor — §17). No price literal exists here.
 * - Yearly is the STORED yearly row — never monthly × anything (§15/§137).
 * - Savings are only shown when deterministically computable from the two
 *   stored prices (§76) and labeled with the computed percent, never
 *   "2 months free".
 * - A currency without an active book shows "not available" — never zero,
 *   never a converted estimate (§19/§23/§78).
 * - CTA states reflect availability: FREE → signup, paid → signup (public)
 *   or billing navigation (authenticated), ENTERPRISE → contact sales,
 *   payments-disabled → contact us (§22/§24-§27).
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import {
  BadgeCheck,
  Building2,
  Check,
  Loader2,
  Minus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { trackClientEvent } from "@/lib/analytics-client";
import { formatMinor } from "@/lib/payments/pricing";
import { useAppStore } from "@/store/app-store";
import { useSubscription } from "@/hooks/use-billing";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { ContactSalesDialog } from "./contact-sales-dialog";
import { LocaleSwitcher, ThemeToggle } from "@/modules/shell/header";

// ---------------------------------------------------------------------------
// Payload types (mirror of the server DTO — no internal ids exist in it)
// ---------------------------------------------------------------------------

type PublicPlan = {
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  selfService: boolean;
  availability: "AVAILABLE" | "NOT_PURCHASABLE" | "NOT_SELF_SERVICE" | "NOT_PRICED";
  pricing: {
    monthlyMinor: number;
    yearlyMinor: number;
    currency: string;
    priceVersion: string;
  } | null;
  entitlements: Record<string, number | null | boolean>;
};

type PublicPricingPayload = {
  plans: PublicPlan[];
  definitions: Array<{ code: string; type: "LIMIT" | "BOOLEAN"; unit: string | null; group: string }>;
  settlementCurrency: string;
  currencies: Array<{
    code: string;
    displayName: string;
    symbol: string;
    minorUnitExponent: number;
    available: boolean;
  }>;
  paymentsEnabled: boolean;
  trialsEnabled: boolean;
  trialDays: number | null;
  featuredPlan: string | null;
};

type BillingPeriod = "MONTHLY" | "YEARLY";

type Translator = ReturnType<typeof useTranslations>;

const PENDING_PLAN_KEY = "abc:pendingPlan";

/** Card-top feature codes (the full matrix lives in the comparison table). */
const CARD_FEATURES = ["CUSTOMERS_MAX", "PRODUCTS_MAX", "TEAM_MEMBERS_MAX", "AI_REQUESTS_MAX"] as const;

export function PricingView() {
  const t = useTranslations("pricing");
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  // Prompt 27 — legal page links in the footer.
  const tLegal = useTranslations("legal");
  const { status } = useSession();
  const authenticated = status === "authenticated";
  const locale = useAppStore((s) => s.locale);
  const setAuthMode = useAppStore((s) => s.setAuthMode);
  const navigate = useAppStore((s) => s.navigate);

  const [period, setPeriod] = useState<BillingPeriod>("MONTHLY");
  /** null = use the payload default; a code = an explicit visitor choice. */
  const [currency, setCurrency] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<PublicPricingPayload>({
    queryKey: ["public-pricing", currency ?? ""],
    queryFn: () =>
      api<PublicPricingPayload>(`/api/v1/public/pricing${currency ? `?currency=${encodeURIComponent(currency)}` : ""}`, {
        businessId: null,
      }),
    staleTime: 30_000,
  });

  // §13/§141 — the authenticated mode needs the CURRENT plan for CTA
  // wording ("Current plan" / "Upgrade"). Server-verified like everywhere.
  const { data: subscriptionPayload } = useSubscription(authenticated);
  const currentPlanCode = authenticated ? (subscriptionPayload?.subscription.plan.code ?? null) : null;

  // §49 — PRICING_VIEWED, once per currency per session (the server also
  // dedupes per day; the ref guards re-render storms client-side).
  const viewedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const key = data.settlementCurrency;
    if (viewedFor.current === key) return;
    viewedFor.current = key;
    trackClientEvent("PRICING_VIEWED", { page: "pricing", currency: key, locale });
  }, [data, locale]);

  // Document title for the public page (in-app, app-shell owns the title).
  useEffect(() => {
    if (authenticated) return;
    document.title = t("seo.title");
  }, [authenticated, t]);

  const plans = useMemo(() => data?.plans ?? [], [data]);

  /** Deterministic yearly savings from the two STORED prices (§76). */
  function savingsPercent(plan: PublicPlan): number | null {
    if (!plan.pricing) return null;
    const { monthlyMinor, yearlyMinor } = plan.pricing;
    const fullYear = monthlyMinor * 12;
    if (fullYear <= 0 || yearlyMinor >= fullYear) return null;
    const percent = Math.round((1 - yearlyMinor / fullYear) * 100);
    return percent > 0 ? percent : null;
  }

  // §120/§25 — selection NEVER mutates a subscription: it records the funnel
  // step and routes into the appropriate flow (signup or billing).
  function selectPlan(plan: PublicPlan) {
    trackClientEvent("PLAN_SELECTED", {
      planCode: plan.code,
      billingPeriod: period,
      currency: data?.settlementCurrency,
      page: "pricing",
      locale,
    });
  }

  function startSignup(planCode: string | null) {
    try {
      if (planCode) {
        window.localStorage.setItem(PENDING_PLAN_KEY, JSON.stringify({ planCode, billingPeriod: period }));
      }
    } catch {
      // storage unavailable — signup still works, the preselect is a nicety
    }
    setAuthMode("signup");
    navigate({ kind: "dashboard" });
  }

  /** CTA model for one plan card (§24-§27). */
  function ctaFor(plan: PublicPlan): {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    variant: "default" | "outline" | "secondary";
  } {
    const isCurrent = currentPlanCode === plan.code;

    if (plan.code === "ENTERPRISE") {
      return { label: t("availability.contactSales"), onClick: () => setContactOpen(true), variant: "outline" };
    }

    if (plan.availability === "NOT_PURCHASABLE") {
      // FREE — signup when public; honest billing navigation when logged in.
      if (!authenticated) {
        return { label: t("availability.startFree"), onClick: () => { selectPlan(plan); startSignup("FREE"); }, variant: "default" };
      }
      return isCurrent
        ? { label: t("availability.currentPlan"), disabled: true, variant: "secondary" }
        : { label: t("availability.changePlan"), onClick: () => navigate({ kind: "settings:billing" }), variant: "outline" };
    }

    if (plan.availability !== "AVAILABLE" || !plan.pricing) {
      // NOT_PRICED in the selected currency (e.g. IRR today) — §23/§78.
      return { label: t("availability.notAvailable"), disabled: true, variant: "outline" };
    }

    if (!data?.paymentsEnabled) {
      // §22 — never fake a checkout; the honest CTA is contact.
      return { label: t("availability.contactUs"), onClick: () => setContactOpen(true), variant: "outline" };
    }

    if (!authenticated) {
      return {
        label: t("availability.choose", { plan: plan.code === "FREE" ? t("plans.FREE.name") : plan.name }),
        onClick: () => { selectPlan(plan); startSignup(plan.code); },
        variant: "default",
      };
    }

    if (isCurrent) {
      return { label: t("availability.currentPlan"), disabled: true, variant: "secondary" };
    }

    // §25 — navigation only; the billing flow owns every mutation.
    const higher = plan.sortOrder > (plans.find((p) => p.code === currentPlanCode)?.sortOrder ?? 0);
    return {
      label: higher ? t("availability.upgrade") : t("availability.changePlan"),
      onClick: () => navigate({ kind: "settings:billing" }),
      variant: higher ? "default" : "outline",
    };
  }

  /** One card's price line (§17 — formatMinor only, no manual math). */
  function priceLine(plan: PublicPlan): React.ReactNode {
    if (plan.code === "FREE") return <span className="text-3xl font-semibold">{t("plans.freePrice")}</span>;
    if (plan.code === "ENTERPRISE") return <span className="text-3xl font-semibold">{t("plans.customPrice")}</span>;
    if (!plan.pricing) {
      return <span className="text-muted-foreground text-sm font-medium">{t("currency.unavailableShort")}</span>;
    }
    const amountMinor = period === "MONTHLY" ? plan.pricing.monthlyMinor : plan.pricing.yearlyMinor;
    const suffix = period === "MONTHLY" ? t("toggle.perMonth") : t("toggle.perYear");
    return (
      <span className="flex items-baseline gap-1">
        <span className="text-3xl font-semibold tabular-nums" dir="ltr">
          {formatMinor(amountMinor, plan.pricing.currency, locale)}
        </span>
        <span className="text-muted-foreground text-sm">{suffix}</span>
      </span>
    );
  }

  // §126/§128 — catalog failed → honest error state, NEVER fallback prices.
  if (isError) {
    return (
      <div className="bg-background flex min-h-svh flex-col" data-view="pricing-error">
        <PublicHeader authenticated={authenticated} onContact={() => setContactOpen(true)} />
        <main className="flex flex-1 items-center justify-center p-6">
          <div className="mx-auto max-w-md space-y-4 text-center">
            <div className="bg-destructive/10 text-destructive mx-auto flex size-12 items-center justify-center rounded-full" aria-hidden="true">
              <Building2 className="size-6" />
            </div>
            <h1 className="text-xl font-semibold">{t("error.title")}</h1>
            <p className="text-muted-foreground text-sm">{t("error.subtitle")}</p>
            <Button onClick={() => void refetch()} variant="outline">
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("error.retry")}
            </Button>
          </div>
        </main>
        <ContactSalesDialog open={contactOpen} onOpenChange={setContactOpen} />
      </div>
    );
  }

  const hasUnavailableCurrency = (data?.currencies ?? []).some((c) => !c.available);

  return (
    <div className="bg-background flex min-h-svh flex-col" data-view="pricing">
      <PublicHeader authenticated={authenticated} onContact={() => setContactOpen(true)} />

      <main className="flex-1">
        {/* Hero */}
        <section className="from-primary/5 via-primary/10 to-primary/5 border-b bg-gradient-to-b">
          <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-12 text-center sm:px-6 lg:py-16">
            <h1 className="text-3xl font-semibold tracking-tight gradient-text sm:text-4xl">
              {t("hero.title")}
            </h1>
            <p className="text-muted-foreground mx-auto max-w-2xl text-base">{t("hero.subtitle")}</p>

            {isLoading || !data ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {tCommon("loading")}
              </div>
            ) : (
              <>
                {/* Billing period toggle (§15) */}
                <div
                  className="bg-background mx-auto flex w-fit items-center gap-1 rounded-full border p-1 shadow-sm"
                  role="tablist"
                  aria-label={t("toggle.monthly")}
                >
                  {(["MONTHLY", "YEARLY"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-selected={period === p}
                      onClick={() => setPeriod(p)}
                      className={cn(
                        "rounded-full px-5 py-2 text-sm font-medium transition-colors",
                        period === p
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {p === "MONTHLY" ? t("toggle.monthly") : t("toggle.yearly")}
                    </button>
                  ))}
                </div>

                {/* Currency selector (§20/§78) — ONLY server-declared currencies */}
                <div className="mx-auto flex flex-col items-center gap-2">
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    {t("currency.label")}
                  </span>
                  <div className="flex flex-wrap items-center justify-center gap-2" role="group" aria-label={t("currency.label")}>
                    {(data.currencies ?? []).map((c) => {
                      const active = data.settlementCurrency === c.code;
                      return (
                        <button
                          key={c.code}
                          type="button"
                          disabled={!c.available}
                          aria-pressed={active}
                          title={c.available ? c.displayName : t("currency.unavailable")}
                          onClick={() => setCurrency(c.code)}
                          className={cn(
                            "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
                            active
                              ? "border-primary bg-primary/10 text-primary"
                              : "text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                            !c.available && "cursor-not-allowed opacity-50 line-through hover:text-muted-foreground",
                          )}
                        >
                          {c.code}
                          {!c.available ? <span className="ms-1.5 text-xs">({t("availability.notAvailable")})</span> : null}
                        </button>
                      );
                    })}
                  </div>
                  {hasUnavailableCurrency ? (
                    <p className="text-muted-foreground max-w-md text-xs">{t("currency.unavailable")}</p>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </section>
        {/* Plan cards (§69/§152 — semantic, price dominant, honest CTAs) */}
        <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6" aria-label={t("compare.title")}>
          {isLoading || !data ? null : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {plans.map((plan) => {
                const cta = ctaFor(plan);
                const save = period === "YEARLY" ? savingsPercent(plan) : null;
                const featured = data.featuredPlan === plan.code;
                return (
                  <Card
                    key={plan.code}
                    className={cn(
                      "relative flex flex-col transition-shadow duration-200 hover:shadow-md",
                      featured && "border-primary/40 shadow-sm ring-1 ring-primary/20",
                    )}
                    data-plan={plan.code}
                  >
                    <CardContent className="flex flex-1 flex-col gap-4 p-5">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="text-base font-semibold">{planDisplayName(plan.code, t)}</h2>
                          {featured ? (
                            <Badge className="bg-primary/10 text-primary border-primary/20" variant="outline">
                              <Sparkles className="size-3" aria-hidden="true" />
                              {t("featured")}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-muted-foreground min-h-[2.5rem] text-xs leading-relaxed">
                          {planTagline(plan.code, t)}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <div className="min-h-[2.75rem]">{priceLine(plan)}</div>
                        {period === "YEARLY" && plan.pricing ? (
                          <p className="text-muted-foreground text-xs">
                            {t("toggle.billedYearly")}
                            {save !== null ? (
                              <span className="text-emerald-600 dark:text-emerald-400"> · {t("toggle.savePercent", { percent: save })}</span>
                            ) : null}
                          </p>
                        ) : null}
                      </div>

                      <Button
                        className="w-full"
                        variant={cta.variant}
                        disabled={cta.disabled}
                        onClick={cta.onClick}
                      >
                        {cta.label}
                      </Button>

                      <ul className="space-y-2 border-t pt-3" aria-label={t("features.title")}>
                        {CARD_FEATURES.map((code) => {
                          const value = plan.entitlements[code];
                          return (
                            <li key={code} className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                              <span>{tBilling(`entitlement.${code}` as "entitlement.CUSTOMERS_MAX")}</span>
                              <span className="text-foreground font-medium">
                                {limitLabel(value, plan.code, t)}
                              </span>
                            </li>
                          );
                        })}
                        <li className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                          <span>{tBilling("entitlement.AI_COPILOT" as "entitlement.AI_COPILOT")}</span>
                          {plan.entitlements.AI_COPILOT ? (
                            <BadgeCheck className="text-emerald-600 size-4 dark:text-emerald-400" aria-label={t("features.included")} />
                          ) : (
                            <Minus className="size-4" aria-label={t("features.notIncluded")} />
                          )}
                        </li>
                      </ul>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* Comparison (§10/§14/§70/§138/§153) — desktop table, scrollable on mobile */}
        {data && data.plans.length > 0 ? (
          <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:px-6" aria-label={t("compare.title")}>
            <div className="mb-4 space-y-1">
              <h2 className="text-xl font-semibold tracking-tight">{t("compare.title")}</h2>
              <p className="text-muted-foreground text-sm">{t("compare.subtitle")}</p>
            </div>
            <ComparisonTable payload={data} locale={locale} />
          </section>
        ) : null}

        {/* FAQ (§111-§115) — the trial item ONLY when trials are enabled (§114) */}
        {data ? (
          <section className="border-t" aria-label={t("faq.title")}>
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-12 sm:px-6">
              <h2 className="text-xl font-semibold tracking-tight">{t("faq.title")}</h2>
              <Accordion type="single" collapsible className="w-full">
                {faqItems(data.trialsEnabled).map((key) => (
                  <AccordionItem key={key} value={key}>
                    <AccordionTrigger className="text-start text-sm font-medium">
                      {/* Flat keys: faq.q1 / faq.a1 (BUGFIX #17 — the raw
                          key path rendered because faq.q1.q never existed). */}
                      {t(`faq.${key}` as "faq.q1")}
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground text-sm leading-relaxed">
                      {t(`faq.a${key.slice(1)}` as "faq.a1")}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </section>
        ) : null}
      </main>

      {/* Footer (§133 — only real destinations; Prompt 27 §68 — legal links) */}
      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs sm:flex-row">
          <p className="flex flex-wrap items-center justify-center gap-3">
            <span className="text-foreground font-medium">{t("footer.pricing")}</span>
            <a href="#pricing-faq" className="hover:text-foreground underline-offset-4 hover:underline">
              {t("footer.faq")}
            </a>
            <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => setContactOpen(true)}>
              {t("footer.contact")}
            </button>
            <span aria-hidden="true" className="bg-border hidden h-3 w-px sm:block" />
            <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => navigate({ kind: "legal", doc: "privacy" })}>
              {tLegal("nav.privacy")}
            </button>
            <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => navigate({ kind: "legal", doc: "terms" })}>
              {tLegal("nav.terms")}
            </button>
            <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => navigate({ kind: "legal", doc: "ai-data-use" })}>
              {tLegal("nav.aiDataUse")}
            </button>
            <button type="button" className="hover:text-foreground underline-offset-4 hover:underline" onClick={() => navigate({ kind: "legal", doc: "trust" })}>
              {tLegal("nav.trust")}
            </button>
          </p>
          <p>{t("footer.note")}</p>
        </div>
      </footer>

      <ContactSalesDialog open={contactOpen} onOpenChange={setContactOpen} />
      <JsonLd payload={data ?? null} locale={locale} />
      <span id="pricing-faq" className="sr-only" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components + helpers
// ---------------------------------------------------------------------------

function PublicHeader({
  authenticated,
  onContact,
}: {
  authenticated: boolean;
  onContact: () => void;
}) {
  const t = useTranslations("pricing");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const setAuthMode = useAppStore((s) => s.setAuthMode);

  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          className="flex items-center gap-2.5"
          onClick={() => {
            setAuthMode("signin");
            navigate({ kind: "dashboard" });
          }}
        >
          <span className="bg-background flex size-9 items-center justify-center rounded-xl border shadow-sm">
            <img src="/logo.svg" alt="" className="size-5" aria-hidden="true" />
          </span>
          <span className="text-start">
            <span className="gradient-text block text-sm font-semibold leading-tight">{tCommon("appName")}</span>
            <span className="text-muted-foreground block text-xs leading-tight">{tCommon("tagline")}</span>
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
              {t("nav.signIn")}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={onContact}>
            {t("availability.contactUs")}
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * Comparison matrix. Desktop: semantic table, plans as columns (§14).
 * Small screens: horizontally scrollable container with a sticky feature
 * column — no shrunken text, no clipped columns (§153).
 */
function ComparisonTable({ payload, locale }: { payload: PublicPricingPayload; locale: string }) {
  const t = useTranslations("pricing");
  const tBilling = useTranslations("billing");

  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof payload.definitions>();
    for (const def of payload.definitions) {
      const list = byGroup.get(def.group) ?? [];
      list.push(def);
      byGroup.set(def.group, list);
    }
    return [...byGroup.entries()];
  }, [payload.definitions]);

  return (
    <div className="bg-background overflow-hidden rounded-xl border shadow-sm">
      <div className="overflow-x-auto" dir="ltr">
        <table className="w-full min-w-[640px] border-collapse text-sm" dir={locale === "fa" ? "rtl" : "ltr"}>
          <caption className="sr-only">{t("compare.title")}</caption>
          <thead>
            <tr className="bg-muted/40 border-b">
              <th scope="col" className="sticky start-0 bg-muted/40 z-10 w-2/5 p-3 text-start font-medium">
                {t("compare.title")}
              </th>
              {payload.plans.map((p) => (
                <th key={p.code} scope="col" className="p-3 text-center font-semibold">
                  {planDisplayName(p.code, t)}
                  <span className="text-muted-foreground block text-xs font-normal tabular-nums">
                    {p.pricing
                      ? formatMinor(
                          payload.plans && p.pricing ? p.pricing.monthlyMinor : 0,
                          p.pricing.currency,
                          locale,
                        )
                      : p.code === "FREE"
                        ? t("plans.freePrice")
                        : t("plans.customPrice")}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, defs]) => (
              <Fragment key={`${group}-header`}>
                <tr className="bg-muted/20">
                  <td
                    colSpan={payload.plans.length + 1}
                    className="text-muted-foreground sticky start-0 p-2 text-xs font-semibold uppercase tracking-wide"
                  >
                    {t(`compare.groups.${group}` as "compare.groups.business")}
                  </td>
                </tr>
                {defs.map((def) => (
                  <tr key={def.code} className="border-t">
                    <th scope="row" className="bg-background sticky start-0 z-10 p-3 text-start font-normal">
                      {tBilling(`entitlement.${def.code}` as "entitlement.CUSTOMERS_MAX")}
                    </th>
                    {payload.plans.map((p) => (
                      <td key={p.code} className="text-center p-3 tabular-nums">
                        <Cell plan={p} code={def.code} type={def.type} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({
  plan,
  code,
  type,
}: {
  plan: PublicPlan;
  code: string;
  type: "LIMIT" | "BOOLEAN";
}) {
  const t = useTranslations("pricing");
  const value = plan.entitlements[code];

  if (type === "BOOLEAN") {
    return value ? (
      <span className="inline-flex items-center justify-center">
        <Check className="text-emerald-600 size-4 dark:text-emerald-400" aria-label={t("features.included")} />
      </span>
    ) : (
      <span className="inline-flex items-center justify-center">
        <X className="text-muted-foreground/50 size-4" aria-label={t("features.notIncluded")} />
      </span>
    );
  }

  return <LimitValue value={value} planCode={plan.code} />;
}

function LimitValue({ value, planCode }: { value: number | null | boolean; planCode: string }) {
  const t = useTranslations("pricing");
  if (typeof value === "boolean" || value === undefined) return <span>—</span>;
  if (value === null) {
    // §11 — "Unlimited" only when the catalog truly defines unlimited;
    // ENTERPRISE nulls are negotiated, displayed as Custom (§83).
    if (planCode === "ENTERPRISE") return <span>{t("features.custom")}</span>;
    return <span>{t("features.unlimited")}</span>;
  }
  return (
    <span>
      {new Intl.NumberFormat().format(value)}
    </span>
  );
}

function limitLabel(
  value: number | null | boolean,
  planCode: string,
  t: Translator,
): string {
  if (typeof value === "boolean" || value === undefined) return "—";
  if (value === null) return planCode === "ENTERPRISE" ? t("features.custom") : t("features.unlimited");
  return t("features.upTo", { count: new Intl.NumberFormat().format(value) });
}

/** Localized plan display names (§8) — the API's English names stay catalog-neutral. */
function planDisplayName(code: string, t: Translator): string {
  const map: Record<string, string> = {
    FREE: t("plans.FREE.name"),
    STARTER: t("plans.STARTER.name"),
    BUSINESS: t("plans.BUSINESS.name"),
    PRO: t("plans.PRO.name"),
    ENTERPRISE: t("plans.ENTERPRISE.name"),
  };
  return map[code] ?? code;
}

function planTagline(code: string, t: Translator): string {
  const map: Record<string, string> = {
    FREE: t("plans.FREE.tagline"),
    STARTER: t("plans.STARTER.tagline"),
    BUSINESS: t("plans.BUSINESS.tagline"),
    PRO: t("plans.PRO.tagline"),
    ENTERPRISE: t("plans.ENTERPRISE.tagline"),
  };
  return map[code] ?? "";
}

/** §111 — the trial FAQ exists ONLY when trials are enabled (§114). */
function faqItems(trialsEnabled: boolean): string[] {
  const keys = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q9", "q10", "q11"];
  return trialsEnabled ? ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11"] : keys;
}

/**
 * §58/§59/§135 — structured data ONLY from the live catalog: one Product
 * with Offers exclusively for plans that are genuinely AVAILABLE in the
 * payload's currency. No IRR offers, no stale prices, no fabricated data.
 */
function JsonLd({ payload, locale }: { payload: PublicPricingPayload | null; locale: string }) {
  const json = useMemo(() => {
    if (!payload) return null;
    const offers = payload.plans
      .filter((p) => p.availability === "AVAILABLE" && p.pricing)
      .map((p) => {
        const digits = payload.currencies.find((c) => c.code === p.pricing!.currency)?.minorUnitExponent ?? 2;
        return {
          "@type": "Offer",
          name: p.name,
          price: (p.pricing!.monthlyMinor / 10 ** digits).toFixed(digits),
          priceCurrency: p.pricing!.currency,
          availability: "https://schema.org/InStock",
        };
      });
    if (offers.length === 0) return null;
    return {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "AI Business Copilot",
      description: locale === "fa" ? "مدیریت کسب‌وکار با دستیار هوشمند" : "Business management with an AI copilot",
      offers,
    };
  }, [payload, locale]);

  if (!json) return null;
  return (
    <script
      type="application/ld+json"
      // Data comes exclusively from the typed catalog above — no user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(json) }}
    />
  );
}

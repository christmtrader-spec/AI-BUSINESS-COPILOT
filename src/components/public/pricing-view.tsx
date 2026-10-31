"use client";

/**
 * Public pricing view — Prompt 25.
 *
 * Renders the SERVER-AUTHORITATIVE plan catalog (GET /api/public/pricing).
 * Hard rules:
 * - NO price literals exist in this file (static scans enforce this): every
 *   amount comes from the API's integer minor units and is formatted with
 *   locale/exponent-aware Intl — never toFixed, never float math.
 * - Availability is rendered honestly (NOT_PRICED is never shown as "Free").
 * - CTAs come from the server's cta matrix — no client-invented "Buy Now".
 * - Funnel events are fire-and-forget posts to /api/public/events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Check, Globe, Loader2, Minus, Moon, Sparkles, Sun, Table2 } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { LOCALES, type Locale } from "@/i18n/config";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { PublicFooter } from "@/components/public/public-footer";
import type { PublicPlanDTO, PublicPricingDTO } from "@/lib/billing/public-pricing";
import { currencyMinorDigits, minorToMajor } from "@/lib/payments/currency";

type BillingPeriodUi = "MONTHLY" | "YEARLY";

/** Locale/exponent-aware money display — NO float math, NO toFixed. */
function formatMinorUnits(amountMinor: number, currency: string, locale: Locale): string {
  const major = minorToMajor(amountMinor, currency);
  const digits = currencyMinorDigits(currency);
  try {
    return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    // Unknown currency → neutral numeric fallback (never a wrong amount).
    return `${major} ${currency}`;
  }
}

async function postFunnelEvent(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch("/api/public/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch {
    // Analytics are fire-and-forget — never block the UI.
  }
}

export function PricingPublicView() {
  const t = useTranslations("pricing");
  const tCommon = useTranslations("common");
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const { resolvedTheme, setTheme } = useTheme();

  const [data, setData] = useState<PublicPricingDTO | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriodUi>("MONTHLY");
  const seenPlansRef = useRef<Set<string>>(new Set());

  const load = useCallback(async (currency?: string | null) => {
    setLoadError(false);
    try {
      const qs = currency ? `?currency=${encodeURIComponent(currency)}` : "";
      const res = await fetch(`/api/public/pricing${qs}`, { cache: "no-store" });
      const json = (await res.json()) as
        | { ok: true; data: PublicPricingDTO }
        | { ok: false; error: { code: string; message: string } };
      if (!json.ok) throw new Error(json.error.code);
      setData(json.data);
    } catch {
      setLoadError(true);
    }
  }, []);

  // Initial load + PRICING_VIEWED (once per page load).
  useEffect(() => {
    void load(null);
    void postFunnelEvent({ eventType: "PRICING_VIEWED", route: "pricing" });
  }, [load]);

  const plans = useMemo(
    () => (data ? [...data.plans].sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [data],
  );

  const featured = useMemo(
    () => plans.find((p) => p.code === "BUSINESS") ?? plans[1] ?? null,
    [plans],
  );

  function onBillingPeriodChange(next: BillingPeriodUi) {
    if (next === billingPeriod) return;
    setBillingPeriod(next);
    void postFunnelEvent({
      eventType: "PRICING_BILLING_PERIOD_CHANGED",
      billingPeriod: next,
      currency: data?.currency,
      route: "pricing",
    });
  }

  function onCurrencyChange(next: string) {
    void load(next);
    void postFunnelEvent({
      eventType: "PRICING_CURRENCY_CHANGED",
      currency: next,
      route: "pricing",
    });
  }

  function markPlanViewed(plan: PublicPlanDTO) {
    if (seenPlansRef.current.has(plan.code)) return;
    seenPlansRef.current.add(plan.code);
    void postFunnelEvent({
      eventType: "PRICING_PLAN_VIEWED",
      planCode: plan.code,
      currency: data?.currency,
      billingPeriod,
      route: "pricing",
    });
  }

  function onCta(plan: PublicPlanDTO) {
    markPlanViewed(plan);
    void postFunnelEvent({
      eventType: "PRICING_CTA_CLICKED",
      planCode: plan.code,
      billingPeriod,
      currency: data?.currency,
      route: "pricing",
    });
    // Intent continuation — plan code + allowlisted dims ONLY (never
    // amounts, book ids or provider fields).
    if (plan.cta.kind === "CONTACT_SALES") {
      if (data?.contactSalesUrl) window.location.href = data.contactSalesUrl;
      return;
    }
    const params = new URLSearchParams();
    params.set("intent", plan.code);
    params.set("billingPeriod", billingPeriod);
    if (data?.currency) params.set("currency", data.currency);
    window.location.href = `/?${params.toString()}`;
  }

  const periodPrice = (plan: PublicPlanDTO): number | null => {
    if (!plan.pricing) return null;
    return billingPeriod === "MONTHLY" ? plan.pricing.monthlyMinor : plan.pricing.yearlyMinor;
  };

  return (
    <div className="bg-background text-foreground flex min-h-svh flex-col" data-view="pricing">
      {/* Header */}
      <header className="bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
          <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Sparkles className="text-primary size-5" aria-hidden="true" />
            <span className="gradient-text">{tCommon("appName")}</span>
          </a>
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
              {/* Hydration-safe icon pair (BUGFIX P51-R1-USER-BUG3): the
                  resolvedTheme ternary rendered Moon on the server and Sun on
                  the client (theme resolves from localStorage post-hydration).
                  CSS class switching renders IDENTICAL HTML on both sides —
                  same pattern as shell/header.tsx. */}
              <Sun className="size-4 dark:hidden" aria-hidden="true" />
              <Moon className="hidden size-4 dark:block" aria-hidden="true" />
            </Button>
            <Button asChild size="sm">
              <a href="/">{t("openApp")}</a>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-8 text-center sm:pt-16">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t("heroTitle")}</h1>
          <p className="text-muted-foreground mx-auto mt-3 max-w-2xl text-base sm:text-lg">
            {t("heroSubtitle")}
          </p>
          {data?.trialAvailable && data.trialDays ? (
            <Badge variant="secondary" className="mt-4 gap-1.5 px-3 py-1 text-sm">
              <Sparkles className="size-3.5" aria-hidden="true" />
              {t("trialBadge", { days: data.trialDays })}
            </Badge>
          ) : null}
        </section>

        {/* Controls */}
        <section className="mx-auto w-full max-w-6xl px-4">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <div
              role="group"
              aria-label={t("billingToggleLabel")}
              className="bg-muted inline-flex rounded-full border p-1"
            >
              {(["MONTHLY", "YEARLY"] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  onClick={() => onBillingPeriodChange(period)}
                  aria-pressed={billingPeriod === period}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors motion-reduce:transition-none ${
                    billingPeriod === period
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {period === "MONTHLY" ? t("billing.monthly") : t("billing.yearly")}
                </button>
              ))}
            </div>
            {data?.currencySwitcherAvailable ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("currencyLabel")}</span>
                <select
                  className="bg-background rounded-md border px-2 py-1.5"
                  value={data.currency}
                  onChange={(e) => onCurrencyChange(e.target.value)}
                  aria-label={t("currencyLabel")}
                >
                  {data.supportedCurrencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </section>

        {/* Plan cards */}
        <section className="mx-auto w-full max-w-6xl px-4 py-10" aria-busy={!data && !loadError}>
          {loadError ? (
            <div className="text-center">
              <p className="text-muted-foreground">{t("loadError")}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(null)}>
                {tCommon("retry")}
              </Button>
            </div>
          ) : !data ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-72 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {plans.map((plan) => {
                const price = periodPrice(plan);
                const isFeatured = featured?.code === plan.code;
                return (
                  <article
                    key={plan.code}
                    onFocus={() => markPlanViewed(plan)}
                    onMouseEnter={() => markPlanViewed(plan)}
                    className={`relative flex flex-col rounded-xl border p-5 transition-shadow hover:shadow-md motion-reduce:transition-none ${
                      isFeatured ? "border-primary/50 shadow-sm ring-1 ring-primary/20" : ""
                    }`}
                  >
                    {isFeatured ? (
                      <Badge className="absolute -top-2.5 end-4">{t("popular")}</Badge>
                    ) : null}
                    <h2 className="text-lg font-semibold">{plan.name}</h2>
                    <p className="text-muted-foreground mt-1 min-h-10 text-sm">
                      {plan.description}
                    </p>

                    <div className="mt-4">
                      {plan.code === "FREE" ? (
                        <div>
                          <span className="text-3xl font-bold">{t("freeLabel")}</span>
                          <p className="text-muted-foreground mt-1 text-xs">{t("freeNote")}</p>
                        </div>
                      ) : plan.code === "ENTERPRISE" ? (
                        <div>
                          <span className="text-xl font-semibold">{t("contactSales")}</span>
                          <p className="text-muted-foreground mt-1 text-xs">{t("customQuote")}</p>
                        </div>
                      ) : price !== null && plan.pricing ? (
                        <div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-3xl font-bold tabular-nums">
                              {formatMinorUnits(price, plan.pricing.currency, locale)}
                            </span>
                            <span className="text-muted-foreground text-sm">
                              {billingPeriod === "MONTHLY"
                                ? t("perMonth")
                                : t("perYear")}
                            </span>
                          </div>
                          {/* Settlement-currency honesty note (never the
                              business display currency — different domains). */}
                          <p className="text-muted-foreground mt-1 text-xs" dir="ltr">
                            {t("settlementNote", { currency: plan.pricing.currency })}
                          </p>
                        </div>
                      ) : (
                        <div>
                          {/* HONEST: a purchasable-tier plan without a price
                              in this currency is NOT "Free". */}
                          <span className="text-xl font-semibold">
                            {t("priceNotConfigured")}
                          </span>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {t("priceNotConfiguredNote")}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* CTA — server-computed matrix only. */}
                    <div className="mt-5">
                      {plan.cta.kind === "SIGNUP" ? (
                        <Button className="w-full" onClick={() => onCta(plan)}>
                          {t("cta.startFree")}
                        </Button>
                      ) : plan.cta.kind === "TRIAL" ? (
                        <Button className="w-full" onClick={() => onCta(plan)}>
                          {plan.cta.trialDays
                            ? t("cta.startTrial", { days: plan.cta.trialDays })
                            : t("cta.startTrialGeneric")}
                        </Button>
                      ) : plan.cta.kind === "GET_STARTED" ? (
                        <Button variant="outline" className="w-full" onClick={() => onCta(plan)}>
                          {t("cta.getStarted")}
                        </Button>
                      ) : data?.contactSalesUrl ? (
                        <Button variant="outline" className="w-full" onClick={() => onCta(plan)}>
                          {t("cta.contactSales")}
                        </Button>
                      ) : (
                        // Honest: no sales contact configured → no fake form.
                        <Button
                          variant="outline"
                          className="w-full"
                          disabled
                          title={t("contactUnavailable")}
                        >
                          {t("cta.contactSales")}
                        </Button>
                      )}
                      {/* Payment honesty: when payment initiation is off,
                          say so — never pretend purchase is one click away. */}
                      {plan.cta.state === "PAYMENT_DISABLED" ? (
                        <p className="text-muted-foreground mt-2 text-center text-xs">
                          {t("paymentDisabledNote")}
                        </p>
                      ) : null}
                    </div>

                    <ul className="mt-5 space-y-2 text-sm">
                      {plan.features.slice(0, 5).map((f) => (
                        <li key={f.code} className="flex items-start gap-2">
                          {f.type === "BOOLEAN" ? (
                            f.value ? (
                              <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
                            ) : (
                              <Minus className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                            )
                          ) : (
                            <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
                          )}
                          <span className={f.type === "BOOLEAN" && !f.value ? "text-muted-foreground" : ""}>
                            {t(`features.${f.code}`)}
                            {f.type === "LIMIT" && typeof f.value === "number" ? (
                              <span className="tabular-nums">
                                {": "}
                                {f.value === null
                                  ? t("compare.unlimited")
                                  : formatNumber(f.value, locale)}
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Comparison table */}
        {data ? (
          <section className="mx-auto w-full max-w-6xl px-4 pb-12">
            <Separator className="mb-8" />
            <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
              <Table2 className="size-5" aria-hidden="true" />
              {t("compare.title")}
            </h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-3xl border-collapse text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th scope="col" className="p-3 text-start font-medium">
                      {t("compare.feature")}
                    </th>
                    {plans.map((p) => (
                      <th key={p.code} scope="col" className="p-3 text-center font-medium">
                        {p.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.plans[0]?.features.map((_, rowIndex) => {
                    const code = data.plans[0].features[rowIndex].code;
                    return (
                      <tr key={code} className="border-b last:border-b-0">
                        <th scope="row" className="text-start font-normal">
                          <span className="block p-3">{t(`features.${code}`)}</span>
                        </th>
                        {plans.map((p) => {
                          const f = p.features[rowIndex];
                          return (
                            <td key={p.code} className="p-3 text-center tabular-nums">
                              {f.type === "BOOLEAN" ? (
                                f.value ? (
                                  <Check
                                    className="mx-auto size-4 text-emerald-600"
                                    aria-label={t("compare.included")}
                                  />
                                ) : (
                                  <Minus
                                    className="text-muted-foreground mx-auto size-4"
                                    aria-label={t("compare.notIncluded")}
                                  />
                                )
                              ) : f.value === null ? (
                                t("compare.unlimited")
                              ) : typeof f.value === "number" ? (
                                formatNumber(f.value, locale)
                              ) : (
                                String(f.value)
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground mt-3 text-xs">{t("compare.sourceNote")}</p>
          </section>
        ) : null}
      </main>

      {/* Sticky-to-bottom footer with legal links (Prompt 27 §59/§101) */}
      <PublicFooter
        notes={[t("footer.honestPrices"), t("footer.currencyNote")]}
      />
    </div>
  );
}

/** Locale-aware integer formatting (counts only — never money). */
function formatNumber(value: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US").format(value);
  } catch {
    return String(value);
  }
}

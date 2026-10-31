"use client";

/**
 * Onboarding — Prompt 25 evolution (incremental; the authoritative business
 * creation POST /api/v1/businesses is UNCHANGED).
 *
 * Steps: Business (mandatory, never skippable) → Trial (OPTIONAL, only when
 * the server reports eligibility) → Done (server-derived checklist + honest
 * completion marker). Rules:
 * - A trial is NEVER created before the business exists (funnel order).
 * - Eligibility/start are always server-checked (OWNER/ADMIN authority).
 * - The checklist reads REAL server data — no client-asserted progress.
 * - ONBOARDING_COMPLETED is once-per-business (server idempotent).
 * - The signup intent (plan code only, allowlisted) may preselect the trial
 *   offer — amounts/book ids are never carried across the funnel.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { signOutWithRevoke } from "@/lib/sign-out-with-revoke";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Circle,
  Coins,
  Globe2,
  Loader2,
  PartyPopper,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import { api, ApiClientError } from "@/lib/api-client";
import { CURRENCIES, findCurrency } from "@/lib/currencies";
import { formatMoney, toMinor } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

const FALLBACK_TIMEZONES = ["UTC", "Asia/Tehran", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];

function timezoneOptions(): string[] {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {
    // older engines
  }
  return FALLBACK_TIMEZONES;
}

type PricingIntent = {
  plan: string | null;
  billingPeriod: "MONTHLY" | "YEARLY" | null;
  currency: string | null;
};

/** Allowlisted signup intent (plan code ONLY — never amounts or book ids). */
function readPricingIntent(): PricingIntent {
  try {
    const raw = window.sessionStorage.getItem("abc:pricingIntent");
    if (!raw) return { plan: null, billingPeriod: null, currency: null };
    const parsed = JSON.parse(raw) as Partial<PricingIntent>;
    const planCodes = ["FREE", "STARTER", "BUSINESS", "PRO", "ENTERPRISE"];
    return {
      plan: typeof parsed.plan === "string" && planCodes.includes(parsed.plan) ? parsed.plan : null,
      billingPeriod:
        parsed.billingPeriod === "MONTHLY" || parsed.billingPeriod === "YEARLY"
          ? parsed.billingPeriod
          : null,
      currency:
        typeof parsed.currency === "string" && /^[A-Z]{3}$/.test(parsed.currency)
          ? parsed.currency
          : null,
    };
  } catch {
    return { plan: null, billingPeriod: null, currency: null };
  }
}

export type CreatedBusiness = {
  business: {
    id: string;
    name: string;
    currencyCode: string;
    currencySymbol: string;
    decimalPrecision: number;
    locale: string;
    timezone: string;
  };
  role: string;
};

type TrialEligibilityDto = {
  eligible: boolean;
  reason: string;
  trialDays: number | null;
  trialPlanCode: string | null;
  currentPlan: string | null;
  subscriptionStatus: string | null;
  previousTrialUsed: boolean;
  businessExists: boolean;
};

type OnboardingStatusDto = {
  hasBusiness: boolean;
  checklist: {
    customersCreated: boolean;
    productsCreated: boolean;
    salesCreated: boolean;
    teamInvited: boolean;
    copilotUsed: boolean;
  } | null;
  trial: {
    active: boolean;
    planCode: string;
    status: string;
    trialStart: string | null;
    trialEnd: string | null;
  } | null;
  onboardingCompleted: boolean;
};

type Step = "business" | "trial" | "done";

export function OnboardingView({
  onCreated,
  title,
}: {
  onCreated: (b: CreatedBusiness) => void;
  title?: boolean;
}) {
  const t = useTranslations("onboarding");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const queryClient = useQueryClient();

  const zones = useMemo(() => timezoneOptions(), []);
  const [step, setStep] = useState<Step>("business");
  const [created, setCreated] = useState<CreatedBusiness | null>(null);
  const [eligibility, setEligibility] = useState<TrialEligibilityDto | null>(null);
  const [status, setStatus] = useState<OnboardingStatusDto | null>(null);
  const intent = useMemo(() => readPricingIntent(), []);

  const [name, setName] = useState("");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [symbol, setSymbol] = useState("$");
  const [precision, setPrecision] = useState(2);
  const [locale, setLocale] = useState<"en" | "fa">("en");
  const [timezone, setTimezone] = useState("UTC");
  const [previewValue, setPreviewValue] = useState("1234.5");
  // Plan-limit errors render INLINE (persistent + actionable) instead of a
  // toast that auto-dismisses into a dead end — the user must be able to
  // reach the pricing page from the exact moment they are blocked.
  const [limitError, setLimitError] = useState<string | null>(null);

  const selectedCurrency = findCurrency(currencyCode);

  function onCurrencyChange(code: string) {
    setCurrencyCode(code);
    const c = findCurrency(code);
    if (c) {
      setSymbol(c.symbol);
      setPrecision(c.precision);
    }
  }

  const createMutation = useMutation({
    mutationFn: async () =>
      api<CreatedBusiness>("/api/v1/businesses", {
        method: "POST",
        businessId: null,
        body: JSON.stringify({
          name,
          currencyCode,
          currencySymbol: symbol,
          decimalPrecision: precision,
          locale,
          timezone,
        }),
      }),
    onSuccess: (data) => {
      setLimitError(null);
      toast({ title: t("successToast"), description: data.business.name });
      // NOTE: the businesses query is NOT invalidated here — refreshing it
      // would make the app shell take over and skip the (optional) trial and
      // done steps. finish() invalidates right before handing over.
      setCreated(data);
      // Proceed to the OPTIONAL trial step (server decides eligibility).
      void api<TrialEligibilityDto>("/api/v1/billing/trial/eligibility", {
        businessId: data.business.id,
      })
        .then((elig) => {
          setEligibility(elig);
          setStep(elig.eligible ? "trial" : "done");
        })
        .catch(() => setStep("done"));
    },
    onError: (err) => {
      const text =
        billingErrorText(err) || (err instanceof ApiClientError ? err.message : tErrors("generic"));
      // Entitlement/limit errors → persistent inline alert with an upgrade
      // CTA (the toast variant auto-dismissed and left the user stranded).
      if (
        err instanceof ApiClientError &&
        (err.code === "ENTITLEMENT_LIMIT_REACHED" || err.code === "ENTITLEMENT_NOT_AVAILABLE")
      ) {
        setLimitError(text);
        return;
      }
      toast({
        title: text,
        variant: "destructive",
      });
    },
  });

  const startTrialMutation = useMutation({
    mutationFn: async () =>
      api<{ started: boolean; already: boolean }>("/api/v1/billing/trial/start", {
        method: "POST",
        businessId: created?.business.id ?? null,
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast({ title: t("trialStartedToast") });
      void queryClient.invalidateQueries({ queryKey: ["subscription"] });
      setStep("done");
    },
    onError: (err) => {
      toast({
        title: billingErrorText(err) || (err instanceof ApiClientError ? err.message : tErrors("generic")),
        variant: "destructive",
      });
      // A failed trial start NEVER blocks onboarding completion.
      setStep("done");
    },
  });

  const skipTrial = useCallback(() => {
    if (!created) return;
    // Funnel: an explicit skip (server allowlist; once per business).
    void api("/api/v1/events", {
      method: "POST",
      businessId: created.business.id,
      body: JSON.stringify({
        eventType: "TRIAL_SKIPPED",
        planCode: eligibility?.trialPlanCode ?? intent.plan,
      }),
    }).catch(() => undefined);
    setStep("done");
  }, [created, eligibility?.trialPlanCode, intent.plan]);

  // Done step — fetch the honest server checklist once per entry.
  useEffect(() => {
    if (step !== "done" || !created) return;
    void api<OnboardingStatusDto>(
      `/api/v1/onboarding/status?businessId=${encodeURIComponent(created.business.id)}`,
      { businessId: created.business.id },
    )
      .then(setStatus)
      .catch(() => setStatus(null));
    // Idempotent completion marker (once per business server-side).
    void api("/api/v1/onboarding/complete", {
      method: "POST",
      businessId: created.business.id,
      body: JSON.stringify({}),
    }).catch(() => undefined);
  }, [step, created]);

  function finish() {
    if (!created) return;
    // Hand over: refresh memberships NOW so the app shell sees the business.
    void queryClient.invalidateQueries({ queryKey: ["businesses"] });
    onCreated(created);
  }

  const previewMinor = useMemo(() => {
    try {
      return formatMoney(toMinor(previewValue || "0", precision), {
        currencyCode,
        currencySymbol: symbol,
        decimalPrecision: precision,
        locale,
      });
    } catch {
      return "—";
    }
  }, [previewValue, precision, currencyCode, symbol, locale]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate();
  }

  const stepOrder: Array<{ key: Step; label: string; icon: React.ReactNode; done: boolean }> = [
    { key: "business", label: t("steps.business"), icon: <Building2 className="size-3.5" />, done: step !== "business" },
    { key: "trial", label: t("steps.trial"), icon: <Sparkles className="size-3.5" />, done: step === "done" },
    { key: "done", label: t("steps.workspace"), icon: <CheckCircle2 className="size-3.5" />, done: false },
  ];

  return (
    <div className="bg-muted/30 flex min-h-svh items-center justify-center p-4 sm:p-8" data-view="onboarding">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 flex size-10 items-center justify-center rounded-xl">
            <Building2 className="text-primary size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight gradient-text">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
          </div>
        </div>

        {/* Stepper — labels from i18n (no hard-coded English strings). */}
        <ol className="flex flex-wrap items-center gap-2 text-xs">
          {stepOrder.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              {i > 0 ? <span className="bg-border h-px w-8" aria-hidden="true" /> : null}
              <span
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                  step === s.key
                    ? "bg-primary/10 text-primary font-medium"
                    : s.done
                      ? "text-muted-foreground"
                      : "text-muted-foreground"
                }`}
                aria-current={step === s.key ? "step" : undefined}
              >
                {s.done ? <CheckCircle2 className="size-4 text-emerald-600" /> : s.icon}
                {s.label}
              </span>
            </li>
          ))}
        </ol>

        {step === "business" ? (
          <Card className="shadow-sm">
            <CardContent className="pt-6">
              <form onSubmit={onSubmit} className="space-y-6" noValidate>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="biz-name">{t("businessName")}</Label>
                    <Input
                      id="biz-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("businessNamePlaceholder")}
                      required
                      maxLength={120}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="biz-currency">{t("currency")}</Label>
                    <Select value={currencyCode} onValueChange={onCurrencyChange}>
                      <SelectTrigger id="biz-currency" dir="ltr">
                        <SelectValue placeholder={t("currencyPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {CURRENCIES.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.code} · {c.symbol} — {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">{t("currencyHint")}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="biz-symbol">{t("symbol")}</Label>
                    <Input
                      id="biz-symbol"
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                      maxLength={8}
                      dir="ltr"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="biz-precision">{t("precision")}</Label>
                    <Select
                      value={String(precision)}
                      onValueChange={(v) => setPrecision(Number(v))}
                    >
                      <SelectTrigger id="biz-precision" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[0, 1, 2, 3, 4].map((p) => (
                          <SelectItem key={p} value={String(p)}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="biz-locale">{t("locale")}</Label>
                    <Select value={locale} onValueChange={(v) => setLocale(v as "en" | "fa")}>
                      <SelectTrigger id="biz-locale" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">{t("localeEn")}</SelectItem>
                        <SelectItem value="fa">{t("localeFa")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="biz-timezone">{t("timezone")}</Label>
                    <Select value={timezone} onValueChange={setTimezone}>
                      <SelectTrigger id="biz-timezone" dir="ltr" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {zones.map((z) => (
                          <SelectItem key={z} value={z}>
                            {z}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">{t("timezoneHint")}</p>
                  </div>
                </div>

                <Separator />

                {limitError ? (
                  <Alert variant="destructive" role="alert" data-testid="plan-limit-alert">
                    <ShieldAlert className="size-4" aria-hidden="true" />
                    <AlertTitle>{tErrors("planLimitTitle")}</AlertTitle>
                    <AlertDescription>
                      <div className="flex flex-col gap-3">
                        <span>{limitError}</span>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm" variant="outline">
                            <a href="/pricing" target="_blank" rel="noopener noreferrer">
                              <ArrowUpRight className="size-4" aria-hidden="true" />
                              {tErrors("upgradeAction")}
                            </a>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setLimitError(null)}
                          >
                            {tErrors("dismiss")}
                          </Button>
                        </div>
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                  <div className="flex items-center gap-2">
                    <Coins className="text-muted-foreground size-4" aria-hidden="true" />
                    <span className="text-sm font-medium">{t("preview")}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={t("preview")}
                      value={previewValue}
                      onChange={(e) => setPreviewValue(e.target.value)}
                      dir="ltr"
                      className="w-32 text-end"
                      inputMode="decimal"
                    />
                    <ArrowRight className="text-muted-foreground size-4 rtl:rotate-180" aria-hidden="true" />
                    <span className="bg-background rounded-md border px-3 py-2 text-sm font-semibold tabular-nums">
                      {previewMinor}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col-reverse items-center justify-between gap-3 sm:flex-row">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <a
                      href="/pricing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm underline-offset-4 transition-colors hover:underline motion-reduce:transition-none"
                    >
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      {t("plansLink")}
                    </a>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void signOutWithRevoke("/")}
                    >
                      {t("signOutInstead")}
                    </Button>
                  </div>
                  <Button type="submit" disabled={createMutation.isPending || !name.trim()} className="w-full sm:w-auto">
                    {createMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Globe2 className="size-4" aria-hidden="true" />
                    )}
                    {createMutation.isPending ? t("creating") : t("create")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {step === "trial" && created && eligibility ? (
          <Card className="shadow-sm">
            <CardContent className="space-y-5 pt-6">
              <div className="flex items-start gap-3">
                <div className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <Sparkles className="text-primary size-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">{t("trialTitle")}</h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {t("trialOffer", {
                      days: eligibility.trialDays ?? 0,
                      plan: eligibility.trialPlanCode ?? "",
                    })}
                  </p>
                  {intent.plan && intent.plan !== "FREE" ? (
                    <Badge variant="secondary" className="mt-2">
                      {t("trialFromPricing", { plan: intent.plan })}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <ul className="text-muted-foreground space-y-1.5 text-sm">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
                  {t("trialPoint1", { plan: eligibility.trialPlanCode ?? "" })}
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
                  {t("trialPoint2")}
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
                  {t("trialPoint3")}
                </li>
              </ul>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={skipTrial} disabled={startTrialMutation.isPending}>
                  {t("trialSkip")}
                </Button>
                <Button onClick={() => startTrialMutation.mutate()} disabled={startTrialMutation.isPending}>
                  {startTrialMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="size-4" aria-hidden="true" />
                  )}
                  {t("trialStart", { days: eligibility.trialDays ?? 0 })}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {step === "done" && created ? (
          <Card className="shadow-sm">
            <CardContent className="space-y-5 pt-6">
              <div className="flex items-start gap-3">
                <div className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <PartyPopper className="text-primary size-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">{t("doneTitle")}</h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {t("doneSubtitle", { name: created.business.name })}
                  </p>
                </div>
              </div>

              {/* Server-derived checklist (counts only — honest state). */}
              <ul className="grid gap-2 sm:grid-cols-2">
                {status?.checklist ? (
                  <>
                    <ChecklistItem done={status.checklist.customersCreated} label={t("checklist.customers")} />
                    <ChecklistItem done={status.checklist.productsCreated} label={t("checklist.products")} />
                    <ChecklistItem done={status.checklist.salesCreated} label={t("checklist.sales")} />
                    <ChecklistItem done={status.checklist.teamInvited} label={t("checklist.team")} />
                    <ChecklistItem done={status.checklist.copilotUsed} label={t("checklist.copilot")} />
                    <ChecklistItem
                      done={!!status.trial?.active}
                      label={t("checklist.trial")}
                      optional
                    />
                  </>
                ) : null}
              </ul>
              <p className="text-muted-foreground text-xs">{t("checklistNote")}</p>

              <div className="flex justify-end">
                <Button onClick={finish} className="w-full sm:w-auto">
                  <ArrowRight className="size-4 rtl:rotate-180" aria-hidden="true" />
                  {t("doneGo")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ChecklistItem({
  done,
  label,
  optional,
}: {
  done: boolean;
  label: string;
  optional?: boolean;
}) {
  const t = useTranslations("onboarding");
  return (
    <li className="bg-background flex items-center gap-2 rounded-lg border p-3 text-sm">
      {done ? (
        <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : (
        <Circle className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      )}
      <span className={done ? "" : "text-muted-foreground"}>{label}</span>
      {optional ? (
        <span className="text-muted-foreground ms-auto text-xs">({t("optionalStep")})</span>
      ) : null}
    </li>
  );
}

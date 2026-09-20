"use client";

import { useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, Building2, CheckCircle2, Coins, Globe2, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { CURRENCIES, findCurrency } from "@/lib/currencies";
import { formatMoney, toMinor } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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

export function OnboardingView({
  onCreated,
  title,
}: {
  onCreated: (b: CreatedBusiness) => void;
  title?: boolean;
}) {
  const t = useTranslations("onboarding");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const zones = useMemo(() => timezoneOptions(), []);
  const [name, setName] = useState("");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [symbol, setSymbol] = useState("$");
  const [precision, setPrecision] = useState(2);
  const [locale, setLocale] = useState<"en" | "fa">("en");
  const [timezone, setTimezone] = useState("UTC");
  const [previewValue, setPreviewValue] = useState("1234.5");

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
      toast({ title: t("successToast"), description: data.business.name });
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      onCreated(data);
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

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

  return (
    <div className="bg-muted/30 flex min-h-svh items-center justify-center p-4 sm:p-8" data-view="onboarding">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 flex size-10 items-center justify-center rounded-xl">
            <Building2 className="text-primary size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
          </div>
        </div>

        <ol className="flex items-center gap-2 text-xs" aria-hidden="true">
          <li className="text-muted-foreground flex items-center gap-1.5">
            <CheckCircle2 className="size-4 text-emerald-600" />
            Account
          </li>
          <li className="bg-border h-px w-8" />
          <li className="bg-primary/10 text-primary flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium">
            <Building2 className="size-3.5" />
            Business
          </li>
          <li className="bg-border h-px w-8" />
          <li className="text-muted-foreground flex items-center gap-1.5">Workspace</li>
        </ol>

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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void signOut({ callbackUrl: "/" })}
                >
                  {t("signOutInstead")}
                </Button>
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
      </div>
    </div>
  );
}

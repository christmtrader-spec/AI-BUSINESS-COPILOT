"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Coins, Globe2, Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { CURRENCIES, findCurrency } from "@/lib/currencies";
import { formatMoney, toMinor } from "@/lib/money";
import { asRole, can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/shared/primitives";
import type { BusinessSummary } from "../shell/types";

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

export function BusinessSettingsView({ business }: { business: BusinessSummary }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const activeId = useAppStore((s) => s.activeBusinessId);

  const { data: fresh } = useQuery<BusinessSummary>({
    queryKey: ["business", activeId],
    queryFn: () => api(`/api/v1/businesses/${activeId}`),
  });
  const current = fresh ?? business;

  const zones = useMemo(() => timezoneOptions(), []);
  const [name, setName] = useState(current.name);
  const [currencyCode, setCurrencyCode] = useState(current.currencyCode);
  const [symbol, setSymbol] = useState(current.currencySymbol);
  const [precision, setPrecision] = useState(current.decimalPrecision);
  const [locale, setLocale] = useState<"en" | "fa">(
    current.locale === "fa" ? "fa" : "en",
  );
  const [timezone, setTimezone] = useState(current.timezone);
  const [syncedKey, setSyncedKey] = useState(current.id + current.updatedAt);
  // React "adjust state during render" pattern — avoids setState-in-effect.
  const currentKey = current.id + current.updatedAt;
  if (currentKey !== syncedKey) {
    setSyncedKey(currentKey);
    setName(current.name);
    setCurrencyCode(current.currencyCode);
    setSymbol(current.currencySymbol);
    setPrecision(current.decimalPrecision);
    setLocale(current.locale === "fa" ? "fa" : "en");
    setTimezone(current.timezone);
  }

  // We read the role from the cached memberships list (AppRoot query).
  const { data: memberships } = useQuery<{ role: string }[]>({
    queryKey: ["businesses"],
    queryFn: () => api("/api/v1/businesses", { businessId: null }),
    staleTime: 60_000,
    enabled: false,
  });
  const role: Role = asRole(
    memberships?.find((m) => (m as { business?: { id?: string } }).business?.id === activeId)?.role,
  );
  const editable = can(role, "settings:manage");

  const saveMutation = useMutation({
    mutationFn: async () =>
      api<BusinessSummary>(`/api/v1/businesses/${activeId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          currencyCode,
          currencySymbol: symbol,
          decimalPrecision: precision,
          locale,
          timezone,
        }),
      }),
    onSuccess: () => {
      toast({ title: t("savedToast") });
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      void queryClient.invalidateQueries({ queryKey: ["business"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("saveError"),
        variant: "destructive",
      });
    },
  });

  const preview = useMemo(() => {
    try {
      return formatMoney(toMinor("1234.5", precision), {
        currencyCode,
        currencySymbol: symbol,
        decimalPrecision: precision,
        locale,
      });
    } catch {
      return "—";
    }
  }, [precision, currencyCode, symbol, locale]);

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-view="settings:business">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (editable) saveMutation.mutate();
        }}
        className="space-y-4"
        noValidate
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="text-primary size-4" aria-hidden="true" />
              {t("sectionGeneral")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="set-name">{t("businessName")}</Label>
              <Input
                id="set-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!editable}
                maxLength={120}
                required
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Coins className="text-primary size-4" aria-hidden="true" />
              {t("sectionCurrency")}
            </CardTitle>
            <CardDescription>{t("currencyHint")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="set-currency">{t("currency")}</Label>
              <Select
                value={currencyCode}
                onValueChange={(v) => {
                  setCurrencyCode(v);
                  const c = findCurrency(v);
                  if (c) {
                    setSymbol(c.symbol);
                    setPrecision(c.precision);
                  }
                }}
                disabled={!editable}
              >
                <SelectTrigger id="set-currency" dir="ltr" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} · {c.symbol} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-symbol">{t("symbol")}</Label>
              <Input
                id="set-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={!editable}
                dir="ltr"
                maxLength={8}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-precision">{t("precision")}</Label>
              <Select
                value={String(precision)}
                onValueChange={(v) => setPrecision(Number(v))}
                disabled={!editable}
              >
                <SelectTrigger id="set-precision" className="w-full">
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
            <div className="bg-muted/40 sm:col-span-3 flex items-center justify-between rounded-lg border px-4 py-3">
              <span className="text-sm font-medium">{t("preview")}</span>
              <span className="bg-background rounded-md border px-3 py-1.5 text-sm font-semibold tabular-nums">
                {preview}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe2 className="text-primary size-4" aria-hidden="true" />
              {t("sectionLocale")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="set-locale">{t("locale")}</Label>
              <Select value={locale} onValueChange={(v) => setLocale(v as "en" | "fa")} disabled={!editable}>
                <SelectTrigger id="set-locale" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English (LTR)</SelectItem>
                  <SelectItem value="fa">فارسی (RTL)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-timezone">{t("timezone")}</Label>
              <Select value={timezone} onValueChange={setTimezone} disabled={!editable}>
                <SelectTrigger id="set-timezone" dir="ltr" className="w-full">
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
            </div>
          </CardContent>
        </Card>

        <Separator />

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={!editable || saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            {saveMutation.isPending ? tCommon("saving") : tCommon("save")}
          </Button>
        </div>
      </form>
    </div>
  );
}

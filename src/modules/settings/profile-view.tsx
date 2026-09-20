"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, Save, UserRound } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { localeLabel, LOCALES } from "@/i18n/config";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/primitives";

type Me = { id: string; name: string | null; email: string; locale: string; createdAt: string };

export function ProfileView() {
  const t = useTranslations("profile");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  const { data: me } = useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => api("/api/v1/me", { businessId: null }),
  });

  const [name, setName] = useState("");
  const [syncedName, setSyncedName] = useState<string | null>(null);
  // React "adjust state during render" pattern — avoids setState-in-effect.
  if (me && me.name !== syncedName) {
    setSyncedName(me.name);
    setName(me.name ?? "");
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: { name?: string; locale?: string }) =>
      api<Me>("/api/v1/me", {
        method: "PATCH",
        businessId: null,
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      toast({ title: t("savedToast") });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      if (data.locale && data.locale !== locale) setLocale(data.locale === "fa" ? "fa" : "en");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  function onLanguageChange(next: string) {
    setLocale(next === "fa" ? "fa" : "en");
    saveMutation.mutate({ locale: next });
  }

  const memberSince = me
    ? new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
        dateStyle: "medium",
      }).format(new Date(me.createdAt))
    : "—";

  return (
    <div className="mx-auto max-w-2xl space-y-6" data-view="profile">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="text-primary size-4" aria-hidden="true" />
            {t("accountSection")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-name">{t("name")}</Label>
            <div className="flex gap-2">
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
              <Button
                variant="outline"
                onClick={() => saveMutation.mutate({ name })}
                disabled={saveMutation.isPending || !name.trim() || name === me?.name}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-email">{t("email")}</Label>
            <Input id="profile-email" value={me?.email ?? ""} disabled dir="ltr" />
          </div>
          <p className="text-muted-foreground text-xs">
            {t("memberSince")}: {memberSince}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("preferencesSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="profile-language">{t("language")}</Label>
          <Select value={locale} onValueChange={onLanguageChange}>
            <SelectTrigger id="profile-language" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((l) => (
                <SelectItem key={l} value={l}>
                  {localeLabel(l)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t("languageHint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

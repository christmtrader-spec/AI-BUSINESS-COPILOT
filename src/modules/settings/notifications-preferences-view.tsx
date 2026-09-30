"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { EffectivePreference } from "../notifications/types";

/**
 * Notification preferences (#/settings/notifications) — Prompt 32 §63-§68/
 * §119/§120/§121/§158.
 *
 * - Per-CATEGORY, per-CHANNEL controls — deliberately NO single "disable
 *   email" switch (§158).
 * - MANDATORY channels render a disabled "Always enabled" state with the
 *   explanatory note (§64/§119/§121) — the server rejects disabling them
 *   with NOTIFICATION_PREFERENCE_FORBIDDEN (§62) regardless of the UI.
 * - Factual copy only — no marketing language (§120).
 */

const SECTIONS = ["SECURITY", "BILLING", "AI", "BUSINESS", "SYSTEM"] as const;
type Section = (typeof SECTIONS)[number];

// 19 catalog types in display order — mirrors src/lib/notifications/catalog.ts.
const TYPES_BY_SECTION: Record<Section, string[]> = {
  SECURITY: [
    "SECURITY_PASSWORD_CHANGED",
    "SECURITY_PASSWORD_RESET_COMPLETED",
    "SECURITY_EMAIL_VERIFIED",
    "SECURITY_MFA_ENABLED",
    "SECURITY_MFA_DISABLED",
    "SECURITY_NEW_LOGIN",
    "SECURITY_SESSIONS_SIGNED_OUT",
  ],
  BILLING: [
    "BILLING_TRIAL_STARTED",
    "BILLING_TRIAL_ENDED",
    "BILLING_SUBSCRIPTION_CHANGED",
    "BILLING_PAYMENT_SUCCEEDED",
    "BILLING_PAYMENT_FAILED",
  ],
  AI: ["AI_USAGE_LIMIT_NEAR", "AI_USAGE_LIMIT_REACHED"],
  BUSINESS: [
    "BUSINESS_EXPORT_COMPLETED",
    "BUSINESS_EXPORT_FAILED",
    "BUSINESS_IMPORT_COMPLETED",
    "BUSINESS_IMPORT_FAILED",
  ],
  SYSTEM: ["SYSTEM_ANNOUNCEMENT"],
};

type PreferencesResponse = { preferences: EffectivePreference[] };

export function NotificationsPreferencesView() {
  const t = useTranslations("notifications");
  const tItems = useTranslations("notifications.items");
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<PreferencesResponse>({
    queryKey: ["notifications", "preferences"],
    queryFn: () => api<PreferencesResponse>("/api/v1/me/notification-preferences"),
    staleTime: 30_000,
  });

  const update = useMutation({
    mutationFn: async (input: { notificationType: string; channel: string; enabled: boolean }) => {
      const res = await fetch("/api/v1/me/notification-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        throw new Error(body?.error?.code ?? `HTTP_${res.status}`);
      }
      return true;
    },
    onSuccess: () => {
      toast({ title: t("prefs.updated") });
    },
    onError: () => {
      toast({ title: t("prefs.updateFailed"), variant: "destructive" });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications", "preferences"] });
    },
  });

  const byKey = new Map<string, EffectivePreference>();
  for (const pref of data?.preferences ?? []) {
    byKey.set(`${pref.notificationType}:${pref.channel}`, pref);
  }

  return (
    <div className="space-y-4" data-testid="notification-preferences">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("prefs.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("prefs.subtitle")}</p>
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="text-muted-foreground p-6 text-sm">{t("errorTitle")}</CardContent>
        </Card>
      ) : (
        SECTIONS.map((section) => (
          <Card key={section}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t(`prefs.section_${section}` as "prefs.section_SYSTEM")}</CardTitle>
              {section === "SYSTEM" ? (
                <CardDescription>{t("prefs.section_SYSTEM_note")}</CardDescription>
              ) : (
                <CardDescription>{t("prefs.mandatoryNote")}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="divide-y">
              {TYPES_BY_SECTION[section].map((type) => {
                const inApp = byKey.get(`${type}:IN_APP`);
                const email = byKey.get(`${type}:EMAIL`);
                return (
                  <div key={type} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="min-w-0 flex-1 text-sm font-medium">
                      {tItems(`${type}.title` as "SECURITY_PASSWORD_CHANGED.title")}
                    </p>
                    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2">
                      {/* In-app channel — ALWAYS mandatory by catalog policy. */}
                      {inApp ? (
                        <label className={cn("flex items-center gap-2 text-sm", !inApp.overridable && "opacity-80")}>
                          <Switch
                            checked={inApp.enabled}
                            disabled
                            aria-label={`${tItems(`${type}.title` as "SECURITY_PASSWORD_CHANGED.title")} — ${t("prefs.inApp")}`}
                          />
                          <span className="text-muted-foreground text-xs">
                            {t("prefs.inApp")}
                            {inApp.mandatory ? (
                              <span className="ms-1 inline-flex items-center gap-0.5">
                                <Lock className="inline size-3" aria-hidden="true" />
                                {t("prefs.mandatory")}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ) : null}
                      {/* Email channel — optional where the catalog allows. */}
                      {email ? (
                        <label className="flex items-center gap-2 text-sm">
                          <Switch
                            checked={email.enabled}
                            disabled={email.mandatory || !email.overridable || update.isPending}
                            onCheckedChange={(checked) =>
                              update.mutate({ notificationType: type, channel: "EMAIL", enabled: checked })
                            }
                            aria-label={`${tItems(`${type}.title` as "SECURITY_PASSWORD_CHANGED.title")} — ${t("prefs.email")}`}
                            data-testid={`pref-email-${type}`}
                          />
                          <span className="text-muted-foreground text-xs">{t("prefs.email")}</span>
                        </label>
                      ) : (
                        <span className="text-muted-foreground/70 text-xs">{t("prefs.channelUnavailable")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))
      )}

      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Lock className="size-3" aria-hidden="true" />
        {t("prefs.mandatoryNote")}
      </p>
    </div>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Bell,
  Briefcase,
  Lock,
  Mail,
  MailX,
  Megaphone,
  Receipt,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
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
 *
 * r52 visual modernization (PRESENTATION ONLY — query keys, mutation
 * payload, aria-labels, testids and all copy keys are byte-identical):
 * - Channel controls became pill "chips" (icon + label + switch) so each
 *   channel reads as one calm unit instead of three floating fragments.
 * - Mandatory channels show an emerald lock badge instead of a bare lock
 *   glyph, and the locked-on switch keeps its gradient (still reads ON).
 * - Unavailable channels render as a dashed muted chip (MailX) instead of
 *   stray text.
 * - Section headers carry a gradient icon tile; rows get hover feedback;
 *   card surfaces are glass (bg/75 + blur) over the app's ambient WebGL.
 */

const SECTIONS = ["SECURITY", "BILLING", "AI", "BUSINESS", "SYSTEM"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_ICONS: Record<Section, LucideIcon> = {
  SECURITY: ShieldCheck,
  BILLING: Receipt,
  AI: Sparkles,
  BUSINESS: Briefcase,
  SYSTEM: Megaphone,
};

// 23 catalog types in display order — mirrors src/lib/notifications/catalog.ts
// (Prompt 37 adds the three BUSINESS_CRM_TASK_* entries and Prompt 38 the
// BUSINESS_INVENTORY_LOW_STOCK entry to the BUSINESS section; their EMAIL
// channel is preference-controlled per §16/§52).
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
    "BUSINESS_CRM_TASK_ASSIGNED",
    "BUSINESS_CRM_TASK_DUE_SOON",
    "BUSINESS_CRM_TASK_OVERDUE",
    "BUSINESS_INVENTORY_LOW_STOCK",
  ],
  SYSTEM: ["SYSTEM_ANNOUNCEMENT"],
};

type PreferencesResponse = { preferences: EffectivePreference[] };

/** Glass surface shared by the section cards (mirrors the auth cards). */
const glassCardClass =
  "relative overflow-hidden border-border/60 bg-background/75 shadow-lg shadow-black/5 backdrop-blur-xl dark:bg-card/60 dark:shadow-black/25";

/** Gradient icon tile in the section header. */
function SectionIconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-gradient-to-br from-emerald-500/15 via-teal-500/10 to-transparent text-emerald-600 dark:text-emerald-400"
    >
      <Icon className="size-4.5" />
    </div>
  );
}

/** Top hairline accent — brand gradient across the card top edge. */
function CardTopHairline() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent"
    />
  );
}

/** "Always enabled" lock badge for mandatory channels. */
function MandatoryBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
      <Lock className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

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
        SECTIONS.map((section) => {
          const SectionIcon = SECTION_ICONS[section];
          return (
            <Card key={section} className={glassCardClass}>
              <CardTopHairline />
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <SectionIconTile icon={SectionIcon} />
                  <CardTitle className="text-base">{t(`prefs.section_${section}` as "prefs.section_SYSTEM")}</CardTitle>
                </div>
                {section === "SYSTEM" ? (
                  <CardDescription>{t("prefs.section_SYSTEM_note")}</CardDescription>
                ) : (
                  <CardDescription>{t("prefs.mandatoryNote")}</CardDescription>
                )}
              </CardHeader>
              <CardContent className="divide-y divide-border/60 px-0 pb-1 pt-0">
                {TYPES_BY_SECTION[section].map((type) => {
                  const inApp = byKey.get(`${type}:IN_APP`);
                  const email = byKey.get(`${type}:EMAIL`);
                  return (
                    <div
                      key={type}
                      className="flex flex-col gap-3 px-6 py-3.5 transition-colors hover:bg-emerald-500/[0.045] dark:hover:bg-emerald-400/[0.05] sm:flex-row sm:items-center sm:justify-between sm:gap-4 motion-reduce:transition-none"
                    >
                      <p className="min-w-0 flex-1 text-sm font-medium">
                        {tItems(`${type}.title` as "SECURITY_PASSWORD_CHANGED.title")}
                      </p>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {/* In-app channel — ALWAYS mandatory by catalog policy. */}
                        {inApp ? (
                          <label
                            className={cn(
                              "flex min-h-11 items-center gap-2.5 rounded-full border border-border/70 bg-muted/40 py-1.5 ps-3 pe-2 transition-colors sm:min-h-0",
                              "hover:border-emerald-500/40 dark:hover:border-emerald-400/40"
                            )}
                          >
                            <Bell
                              aria-hidden="true"
                              className={cn(
                                "size-4 shrink-0",
                                inApp.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                              )}
                            />
                            <span className="text-muted-foreground text-xs font-medium">{t("prefs.inApp")}</span>
                            {inApp.mandatory ? <MandatoryBadge label={t("prefs.mandatory")} /> : null}
                            <Switch
                              checked={inApp.enabled}
                              disabled
                              aria-label={`${tItems(`${type}.title` as "SECURITY_PASSWORD_CHANGED.title")} — ${t("prefs.inApp")}`}
                            />
                          </label>
                        ) : null}
                        {/* Email channel — optional where the catalog allows. */}
                        {email ? (
                          <label
                            className={cn(
                              "flex min-h-11 items-center gap-2.5 rounded-full border border-border/70 bg-muted/40 py-1.5 ps-3 pe-2 transition-colors sm:min-h-0",
                              email.mandatory || !email.overridable
                                ? ""
                                : "hover:border-emerald-500/40 dark:hover:border-emerald-400/40"
                            )}
                          >
                            <Mail
                              aria-hidden="true"
                              className={cn(
                                "size-4 shrink-0",
                                email.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                              )}
                            />
                            <span className="text-muted-foreground text-xs font-medium">{t("prefs.email")}</span>
                            {email.mandatory || !email.overridable ? (
                              <MandatoryBadge label={t("prefs.mandatory")} />
                            ) : null}
                            <Switch
                              checked={email.enabled}
                              disabled={email.mandatory || !email.overridable || update.isPending}
                              onCheckedChange={(checked) =>
                                update.mutate({ notificationType: type, channel: "EMAIL", enabled: checked })
                              }
                              aria-label={`${tItems(`${type}.title` as "SECURITY_PASSWORD_CHANGED.title")} — ${t("prefs.email")}`}
                              data-testid={`pref-email-${type}`}
                            />
                          </label>
                        ) : (
                          <span className="text-muted-foreground/70 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-border/80 px-3 py-1.5 text-xs sm:min-h-0">
                            <MailX className="size-3.5" aria-hidden="true" />
                            {t("prefs.channelUnavailable")}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })
      )}

      <p className="text-muted-foreground flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <span>{t("prefs.mandatoryNote")}</span>
      </p>
    </div>
  );
}

"use client";

import {
  Bot,
  CheckCircle2,
  Circle,
  ClipboardList,
  Map,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAppStore } from "@/store/app-store";
import { asRole, can, type Role } from "@/lib/rbac";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/primitives";
import { useSession } from "next-auth/react";
import type { BusinessListItem } from "../shell/types";

export function DashboardView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("dashboard");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const { data: session } = useSession();

  const role: Role = asRole(membership.role);

  const steps = [
    { done: true, icon: CheckCircle2, label: t("stepBusinessDone"), action: null as null | { label: string; view: Parameters<typeof navigate>[0] } },
    { done: false, icon: Settings2, label: t("stepSettings"), action: { label: t("openSettings"), view: { kind: "settings:business" } as const } },
    { done: false, icon: Users, label: t("stepInvite"), action: can(role, "members:manage") ? { label: t("openMembers"), view: { kind: "settings:members" } as const } : null },
    { done: false, icon: ClipboardList, label: t("stepComing"), action: null },
  ];

  return (
    <div className="space-y-6" data-view="dashboard">
      <PageHeader
        title={`${t("welcomeBack")}${session?.user?.name ? `, ${session.user.name.split(" ")[0]}` : ""}`}
        subtitle={t("subtitle")}
        actions={
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
            <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden="true" />
            {tSettings(`roles.${role}` as "OWNER")}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Getting started */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Map className="text-primary size-4" aria-hidden="true" />
              {t("gettingStarted")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {steps.map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                      step.done ? "bg-emerald-600/10 text-emerald-600" : "bg-muted text-muted-foreground"
                    }`}
                    aria-hidden="true"
                  >
                    <step.icon className="size-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                    <span className={`text-sm ${step.done ? "text-muted-foreground line-through" : ""}`}>
                      {step.label}
                    </span>
                    {step.action ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        onClick={() => navigate(step.action!.view)}
                      >
                        {step.action.label}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* Copilot teaser */}
        <Card className="from-primary/5 border-primary/20 bg-gradient-to-br to-transparent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="text-primary size-4" aria-hidden="true" />
              {t("copilotTeaser")}
            </CardTitle>
            <CardDescription>{t("copilotTeaserDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" size="sm" className="w-full" disabled>
              <Bot className="size-4" aria-hidden="true" />
              {tCommon("comingSoon")}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* At a glance — honest empty state (Rule 05: no fake numbers) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("atAGlance")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground flex items-start gap-3 text-sm">
              <Circle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>{t("metricsComing")}</p>
            </div>
          </CardContent>
        </Card>

        {/* Roadmap */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("roadmap")}</CardTitle>
            <CardDescription>
              {t("phaseNotice")} — {t("phaseNoticeDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {(["p1", "p2", "p3", "p4", "p5"] as const).map((k) => (
                <li
                  key={k}
                  className={`rounded-md border px-3 py-2 ${
                    k === "p1" ? "border-primary/30 bg-primary/5 font-medium" : "text-muted-foreground"
                  }`}
                >
                  {t(`roadmapItems.${k}`)}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

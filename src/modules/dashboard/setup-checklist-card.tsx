"use client";

/**
 * SetupChecklistCard — Prompt 25 §99/§100.
 *
 * The post-onboarding checklist on the dashboard. Tasks derive from REAL
 * data (the onboarding/status endpoint counts actual customers/products/
 * sales/copilot sessions — §100: no duplicate boolean flags), only
 * unfinished tasks are shown, and completing everything marks the business
 * activated (server-side, §48). "Hide" dismisses for this business
 * (server state — §98), never a localStorage lie.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Bot,
  ChevronRight,
  Loader2,
  Package,
  PartyPopper,
  ShoppingCart,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useAppStore, type AppView } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type OnboardingStatus = {
  onboardingCompletedAt: string | null;
  onboardingDismissedAt: string | null;
  checklist: Record<"addCustomer" | "addProduct" | "createSale" | "askCopilot", { done: boolean; count: number }>;
  allDone: boolean;
};

export function SetupChecklistCard() {
  const t = useTranslations("dashboard");
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["onboarding", "status"],
    queryFn: () => api("/api/v1/onboarding/status"),
    staleTime: 15_000,
  });

  const dismiss = useMutation({
    mutationFn: async () => api("/api/v1/onboarding/dismiss", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
  });

  if (isLoading) {
    return (
      <Card className="animate-pulse" data-view="setup-checklist">
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        </CardContent>
      </Card>
    );
  }

  // Completed or dismissed businesses never see the checklist (§99 hides
  // finished tasks; a dismissed flow keeps the workspace uncluttered).
  if (!data || data.onboardingCompletedAt || data.onboardingDismissedAt) return null;

  const tasks: Array<{ key: keyof OnboardingStatus["checklist"]; label: string; view: AppView; icon: React.ReactNode }> = [
    { key: "addCustomer", label: t("checklistTaskCustomer"), view: { kind: "module", module: "customers" }, icon: <Users className="size-4" aria-hidden="true" /> },
    { key: "addProduct", label: t("checklistTaskProduct"), view: { kind: "module", module: "products" }, icon: <Package className="size-4" aria-hidden="true" /> },
    { key: "createSale", label: t("checklistTaskSale"), view: { kind: "module", module: "sales" }, icon: <ShoppingCart className="size-4" aria-hidden="true" /> },
    { key: "askCopilot", label: t("checklistTaskCopilot"), view: { kind: "module", module: "copilot" }, icon: <Bot className="size-4" aria-hidden="true" /> },
  ];

  const remaining = tasks.filter((task) => !data.checklist[task.key].done);
  if (remaining.length === 0) return null;

  return (
    <Card className="border-primary/20 from-primary/5 bg-gradient-to-br to-transparent transition-shadow duration-200 hover:shadow-md motion-reduce:transition-none" data-view="setup-checklist">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <PartyPopper className="text-primary size-4" aria-hidden="true" />
            {t("checklistTitle")}
          </CardTitle>
          <CardDescription>{t("checklistSubtitle")}</CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => dismiss.mutate()}
          disabled={dismiss.isPending}
          aria-label={t("checklistDismiss")}
        >
          <X className="size-4" aria-hidden="true" />
          {t("checklistDismiss")}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {remaining.map((task) => (
            <li key={task.key}>
              <button
                type="button"
                className="hover:border-primary/40 hover:bg-primary/5 flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-start text-sm transition-colors motion-reduce:transition-none"
                onClick={() => navigate(task.view)}
              >
                <span className="flex items-center gap-2.5">
                  <span className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
                    {task.icon}
                  </span>
                  {task.label}
                </span>
                <ChevronRight className="text-muted-foreground size-4 rtl:rotate-180" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

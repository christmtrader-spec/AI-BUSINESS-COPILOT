"use client";

import { ArrowLeft, Rocket } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/primitives";

const MODULE_LABEL_KEY: Record<string, string> = {
  customers: "customers",
  suppliers: "suppliers",
  products: "products",
  inventory: "inventory",
  sales: "sales",
  expenses: "expenses",
  payments: "payments",
  receivables: "receivables",
  payables: "payables",
  copilot: "copilot",
  reports: "reports",
};

export function ComingSoonView({ module }: { module: string }) {
  const t = useTranslations("comingSoon");
  const tNav = useTranslations("nav");
  const navigate = useAppStore((s) => s.navigate);

  const labelKey = MODULE_LABEL_KEY[module];
  const moduleLabel = labelKey ? tNav(labelKey as "customers") : module;
  const phase = t(`phases.${labelKey ?? "reports"}` as "reports");

  return (
    <div className="mx-auto max-w-xl pt-8" data-view={`module:${module}`}>
      <EmptyState
        icon={Rocket}
        title={t("title", { module: moduleLabel })}
        description={t("description")}
      />
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm">{t("phase", { phase })}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => navigate({ kind: "dashboard" })}>
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
            {t("backToDashboard")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

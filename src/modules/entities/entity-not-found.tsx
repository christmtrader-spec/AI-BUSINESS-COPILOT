"use client";

/**
 * Prompt 34 — shared not-found state (§80).
 * The SAME message serves "never existed", "deleted" and "other business"
 * (§20) — no tenant-existence leak, no raw id rendered.
 */

import { SearchX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function EntityNotFound({
  backToList,
  onBackToList,
  dashboardLabel,
  onDashboard,
}: {
  backToList: string;
  onBackToList: () => void;
  dashboardLabel: string;
  onDashboard: () => void;
}) {
  const t = useTranslations("entityDetail");
  return (
    <div
      role="status"
      className="bg-card text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-xl border px-6 py-12 text-center text-sm"
    >
      <span className="flex size-10 items-center justify-center rounded-full border">
        <SearchX className="size-5" aria-hidden="true" />
      </span>
      <p className="text-foreground text-base font-medium">{t("notFound")}</p>
      <p className="max-w-sm">{t("notFoundDesc")}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBackToList}>
          {backToList}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDashboard}>
          {dashboardLabel}
        </Button>
      </div>
    </div>
  );
}

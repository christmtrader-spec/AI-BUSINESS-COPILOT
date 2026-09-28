"use client";

/**
 * Platform system view (§59/§60/§85/§122): safe readiness — statuses only
 * (READY / NOT_CONFIGURED / BLOCKED / DISABLED), no secrets, no raw env
 * dump. Reuses the Prompt-27 trust configuration summary (§60).
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { platformQueries } from "./platform-api";
import { EmptyState, ListSkeleton, StatusBadge, formatDateTime } from "./kit";

export function SystemView() {
  const t = useTranslations("platform");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "system"],
    queryFn: platformQueries.system,
    refetchOnWindowFocus: false,
  });

  if (isLoading) return <ListSkeleton rows={4} />;
  if (isError || !data) return <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">{formatDateTime(data.generatedAt)}</p>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("system.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {data.components.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t(`systemKeys.${c.key}` as Parameters<typeof t>[0])}</p>
                  {c.detail ? <p className="text-muted-foreground text-xs" dir="auto">{c.detail}</p> : null}
                </div>
                <StatusBadge status={c.status} label={t(`systemStatus.${c.status}` as Parameters<typeof t>[0])} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

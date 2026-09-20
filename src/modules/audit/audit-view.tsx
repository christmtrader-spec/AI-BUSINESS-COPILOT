"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ScrollText } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { asRole, can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import type { AuditEntry, BusinessListItem } from "../shell/types";

function formatAction(action: string): string {
  return action.replace(/[._-]+/g, " ");
}

function initialsOf(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}

export function AuditView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("audit");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const locale = useAppStore((s) => s.locale);
  const activeId = useAppStore((s) => s.activeBusinessId);

  const role: Role = asRole(membership.role);
  const allowed = can(role, "audit:read");

  const { data: logs, isLoading, error, refetch, isFetching } = useQuery<AuditEntry[]>({
    queryKey: ["audit", activeId],
    queryFn: () => api(`/api/v1/audit?take=100`),
    enabled: allowed,
  });

  const fmt = new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (!allowed) {
    return (
      <div className="mx-auto max-w-2xl pt-8" data-view="audit">
        <EmptyState icon={ScrollText} title={tErrors("forbidden")} />
      </div>
    );
  }

  const items = logs ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-view="audit">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card>
        <CardContent className="pt-6">
          {error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {error instanceof ApiClientError && error.status === 403
                ? tErrors("forbidden")
                : tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <DataTable<AuditEntry>
              ariaLabel={t("title")}
              sortLocale={locale}
              maxHeightClass="max-h-[34rem]"
              stickyHeader
              refreshing={isFetching && !isLoading}
              columns={[
                {
                  id: "time",
                  header: t("time"),
                  className: "w-44",
                  sortValue: (l) => l.createdAt,
                  defaultSortDir: "desc",
                  cell: (l) => (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {fmt.format(new Date(l.createdAt))}
                    </span>
                  ),
                },
                {
                  id: "actor",
                  header: t("actor"),
                  cell: (l) => {
                    const name = l.actor?.name ?? l.actor?.email ?? t("system");
                    return (
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-7 ring-1 ring-border">
                          <AvatarFallback className="bg-teal-500/10 text-[10px] font-semibold text-teal-700 dark:text-teal-300">
                            {l.actor?.name || l.actor?.email
                              ? initialsOf(l.actor?.name ?? l.actor?.email ?? "")
                              : "AI"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="max-w-40 truncate text-sm font-medium">{name}</span>
                      </div>
                    );
                  },
                },
                {
                  id: "action",
                  header: t("action"),
                  cell: (l) => (
                    <Badge variant="secondary" className="font-normal" dir="ltr">
                      {formatAction(l.action)}
                    </Badge>
                  ),
                },
                {
                  id: "entity",
                  header: t("entity"),
                  hideBelow: "sm",
                  cell: (l) => (
                    <span className="text-muted-foreground text-sm">
                      <Ltr>
                        {l.entityType}
                        {l.entityId ? ` · ${l.entityId.slice(-6)}` : ""}
                      </Ltr>
                    </span>
                  ),
                },
              ]}
              rows={items}
              getRowId={(l) => l.id}
              loading={isLoading}
              skeletonRows={6}
              empty={
                <EmptyState
                  icon={ScrollText}
                  title={t("empty")}
                  description={t("emptyDesc")}
                />
              }
            />
          )}
        </CardContent>
      </Card>

      <div className="text-muted-foreground flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {tCommon("retry")}
        </Button>
      </div>
    </div>
  );
}

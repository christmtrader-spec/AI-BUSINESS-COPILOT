"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ScrollText } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { asRole, can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import type { AuditEntry, BusinessListItem } from "../shell/types";

function formatAction(action: string): string {
  return action.replace(/[._-]+/g, " ");
}

export function AuditView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("audit");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const locale = useAppStore((s) => s.locale);
  const activeId = useAppStore((s) => s.activeBusinessId);

  const role: Role = asRole(membership.role);
  const allowed = can(role, "audit:read");

  const { data: logs, isLoading, error, refetch } = useQuery<AuditEntry[]>({
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

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-view="audit">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-muted/50 h-10 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {error instanceof ApiClientError && error.status === 403
                ? tErrors("forbidden")
                : tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : !logs || logs.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={t("empty")}
              description={t("emptyDesc")}
            />
          ) : (
            <div className="max-h-[32rem] overflow-y-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50 sticky top-0">
                  <TableRow>
                    <TableHead className="w-44">{t("time")}</TableHead>
                    <TableHead>{t("actor")}</TableHead>
                    <TableHead>{t("action")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("entity")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                        {fmt.format(new Date(l.createdAt))}
                      </TableCell>
                      <TableCell className="max-w-40 truncate text-sm">
                        {l.actor?.name ?? l.actor?.email ?? t("system")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal" dir="ltr">
                          {formatAction(l.action)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-sm sm:table-cell" dir="ltr">
                        {l.entityType}
                        {l.entityId ? ` · ${l.entityId.slice(-6)}` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
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

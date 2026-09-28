"use client";

/**
 * Platform audit view (§58/§117): paginated, filterable, newest first.
 * Formatted fields — no giant raw JSON wall (§117); payloads render as
 * compact key/value chips.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformQueries, type PlatformAuditEntry } from "./platform-api";
import { EmptyState, ListSkeleton, PaginationBar, formatDateTime } from "./kit";

const PAGE_SIZE = 20;

export function PlatformAuditView() {
  const t = useTranslations("platform");
  const [action, setAction] = React.useState("");
  const [businessId, setBusinessId] = React.useState("");
  const [page, setPage] = React.useState(1);

  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (businessId) params.set("businessId", businessId);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "audit", params.toString()],
    queryFn: () => platformQueries.audit(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows: PlatformAuditEntry[] = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pf-audit-action">{t("audit.filterAction")}</Label>
            <Input
              id="pf-audit-action"
              dir="ltr"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              placeholder="billing.subscription_paused"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-audit-biz">{t("audit.filterBusiness")}</Label>
            <Input
              id="pf-audit-biz"
              dir="ltr"
              value={businessId}
              onChange={(e) => {
                setBusinessId(e.target.value);
                setPage(1);
              }}
              placeholder="cuid…"
            />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("audit.empty")} />
      ) : (
        <>
          <div className="space-y-2">
            {rows.map((e) => (
              <div key={e.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-xs font-semibold" dir="ltr">
                    {e.action}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(e.createdAt)}
                  </span>
                  {e.operatorEmail ? (
                    <span className="text-muted-foreground text-xs" dir="ltr">
                      {e.operatorEmail}
                      {e.operatorRole ? ` · ${e.operatorRole}` : ""}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                  <span className="text-muted-foreground">
                    {t("audit.entity")}: <span className="font-mono" dir="ltr">{e.entityType}</span>
                  </span>
                  {e.targetBusinessId ? (
                    <span className="text-muted-foreground">
                      {t("audit.business")}: <span className="font-mono" dir="ltr">{e.targetBusinessId}</span>
                    </span>
                  ) : null}
                  {e.targetUserId ? (
                    <span className="text-muted-foreground">
                      {t("audit.user")}: <span className="font-mono" dir="ltr">{e.targetUserId}</span>
                    </span>
                  ) : null}
                  {e.requestId ? (
                    <span className="text-muted-foreground">
                      req: <span className="font-mono" dir="ltr">{e.requestId.slice(0, 13)}…</span>
                    </span>
                  ) : null}
                </div>
                {e.reason ? (
                  <p className="mt-1 border-s-2 ps-2 text-sm">{e.reason}</p>
                ) : null}
              </div>
            ))}
          </div>

          <PaginationBar
            page={data?.page.page ?? 1}
            hasNext={data?.page.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

    </div>
  );
}

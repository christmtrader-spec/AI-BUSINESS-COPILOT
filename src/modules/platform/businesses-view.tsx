"use client";

/**
 * Platform business search (§19) + business detail (§20). Filters are
 * allowlisted server-side; the table degrades to stacked cards on mobile.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformQueries, type PlatformBusiness } from "./platform-api";
import {
  EmptyState,
  Field,
  formatCount,
  formatDateTime,
  formatMinor,
  ListSkeleton,
  PaginationBar,
  StatusBadge,
} from "./kit";

const PAGE_SIZE = 20;

export function BusinessesView() {
  const t = useTranslations("platform");
  const [filters, setFilters] = React.useState({ name: "", ownerEmail: "" });
  const [page, setPage] = React.useState(1);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const params = new URLSearchParams();
  if (filters.name) params.set("name", filters.name);
  if (filters.ownerEmail) params.set("ownerEmail", filters.ownerEmail);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "businesses", params.toString()],
    queryFn: () => platformQueries.businesses(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows: PlatformBusiness[] = data?.businesses ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="pf-biz-name">{t("businesses.filterName")}</Label>
            <Input
              id="pf-biz-name"
              value={filters.name}
              onChange={(e) => {
                setFilters((f) => ({ ...f, name: e.target.value }));
                setPage(1);
              }}
              placeholder={t("businesses.filterNamePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-biz-owner">{t("businesses.filterOwner")}</Label>
            <Input
              id="pf-biz-owner"
              type="email"
              dir="ltr"
              value={filters.ownerEmail}
              onChange={(e) => {
                setFilters((f) => ({ ...f, ownerEmail: e.target.value }));
                setPage(1);
              }}
              placeholder="owner@example.com"
            />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("businesses.empty")} />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("businesses.name")}</TableHead>
                  <TableHead>{t("businesses.owner")}</TableHead>
                  <TableHead className="text-center">{t("businesses.members")}</TableHead>
                  <TableHead>{t("businesses.currency")}</TableHead>
                  <TableHead>{t("businesses.created")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="font-medium">{b.name}</div>
                      <div className="text-muted-foreground font-mono text-xs" dir="ltr">
                        {b.slug}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span dir="ltr" className="text-xs">
                        {b.ownerEmail ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{b.memberCount}</TableCell>
                    <TableCell className="font-mono text-xs">{b.currencyCode}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDateTime(b.createdAt)}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button variant="outline" size="sm" onClick={() => setDetailId(b.id)}>
                        {t("common.details")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-2 md:hidden">
            {rows.map((b) => (
              <Card key={b.id}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{b.name}</span>
                    <span className="font-mono text-xs">{b.currencyCode}</span>
                  </div>
                  <p className="text-muted-foreground text-xs" dir="ltr">
                    {b.ownerEmail ?? "—"} · {formatCount(b.memberCount)} members
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setDetailId(b.id)}>
                    {t("common.details")}
                  </Button>
                </CardContent>
              </Card>
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

      <BusinessDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function BusinessDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations("platform");
  const tSub = useTranslations("platform.subscriptionStatus");
  const { data, isLoading } = useQuery({
    queryKey: ["platform", "business", id],
    queryFn: () => platformQueries.business(id!),
    enabled: !!id,
    refetchOnWindowFocus: false,
  });

  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("businesses.detailTitle")}</DialogTitle>
          <DialogDescription>{data?.business.name ?? ""}</DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <ListSkeleton rows={3} />
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3">
              <Field label={t("businesses.name")}>{data.business.name}</Field>
              <Field label={t("businesses.slug")}>
                <span dir="ltr">{data.business.slug}</span>
              </Field>
              <Field label={t("businesses.owner")}>
                <span dir="ltr">{data.business.ownerEmail ?? "—"}</span>
              </Field>
              <Field label={t("businesses.members")}>{data.business.memberCount}</Field>
              <Field label={t("businesses.currency")}>
                {data.business.currencyCode} · {data.business.locale} · {data.business.timezone}
              </Field>
              <Field label={t("businesses.created")}>{formatDateTime(data.business.createdAt)}</Field>
            </dl>

            <Separator />
            {data.subscription ? (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={data.subscription.status} label={tSub(data.subscription.status as Parameters<typeof tSub>[0])} />
                <span className="text-sm font-medium">{data.subscription.planCode}</span>
                <span className="text-muted-foreground text-xs">
                  {data.subscription.billingPeriod}
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t("businesses.noSubscription")}</p>
            )}

            <Separator />
            <dl className="grid grid-cols-2 gap-3">
              <Field label={t("businesses.usageEvents")}>{formatCount(data.usage.usageEvents)}</Field>
              <Field label={t("businesses.meteredUnits")}>{formatCount(data.usage.totalMeteredUnits)}</Field>
            </dl>

            {data.payments.length > 0 ? (
              <>
                <Separator />
                <ul className="space-y-1.5">
                  {data.payments.slice(0, 5).map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-xs" dir="ltr">
                        {p.provider} · {p.status}
                      </span>
                      <span className="tabular-nums">{formatMinor(p.amountMinor, p.currency)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

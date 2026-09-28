"use client";

/**
 * Platform payments (§30/§31/§32/§91/§92): read-only lists over checkout
 * sessions / transactions / webhook events; reverify (provider remains
 * authoritative) + investigation recording. NO endpoint here (and none in
 * the app) can set a payment result directly (§31/§33/§81).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { platformMutations, platformQueries, type PlatformPayment } from "./platform-api";
import {
  EmptyState,
  ListSkeleton,
  PaginationBar,
  ReauthDialog,
  StatusBadge,
  formatDateTime,
  formatMinor,
  usePlatformErrorText,
} from "./kit";

const PAGE_SIZE = 20;

export function PaymentsView() {
  const t = useTranslations("platform");
  const tPay = useTranslations("platform.paymentStatus");
  const [businessId, setBusinessId] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [reverifyTarget, setReverifyTarget] = React.useState<PlatformPayment | null>(null);
  const [investigateTarget, setInvestigateTarget] = React.useState<PlatformPayment | null>(null);

  const params = new URLSearchParams();
  if (businessId) params.set("businessId", businessId);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "payments", params.toString()],
    queryFn: () => platformQueries.payments(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows = data?.items ?? [];
  const sessions = rows.filter((r) => r.kind === "checkout_session");

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-[1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="pf-pay-biz">{t("payments.filterBusiness")}</Label>
            <Input
              id="pf-pay-biz"
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
        <EmptyState label={t("payments.empty")} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("payments.kind")}</TableHead>
                  <TableHead>{t("payments.provider")}</TableHead>
                  <TableHead>{t("payments.status")}</TableHead>
                  <TableHead>{t("payments.amount")}</TableHead>
                  <TableHead>{t("payments.date")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={`${p.kind}-${p.id}`}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{t(`paymentKinds.${p.kind}` as Parameters<typeof t>[0])}</div>
                      <div className="text-muted-foreground font-mono text-[10px]" dir="ltr">
                        {p.id}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.provider}</TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} label={tPay(p.status as Parameters<typeof tPay>[0])} />
                      {p.reconciliationReason ? (
                        <div className="text-muted-foreground mt-1 text-[10px]">{p.reconciliationReason}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {p.amountMinor != null && p.currency ? formatMinor(p.amountMinor, p.currency) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDateTime(p.createdAt)}
                    </TableCell>
                    <TableCell className="text-end">
                      {p.kind === "checkout_session" ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t("payments.reverify")}
                            title={t("payments.reverify")}
                            onClick={() => setReverifyTarget(p)}
                          >
                            <RefreshCw className="size-3.5" aria-hidden="true" />
                            <span className="hidden lg:inline">{t("payments.reverify")}</span>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t("payments.investigate")}
                            title={t("payments.investigate")}
                            onClick={() => setInvestigateTarget(p)}
                          >
                            <Search className="size-3.5" aria-hidden="true" />
                            <span className="hidden lg:inline">{t("payments.investigate")}</span>
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 md:hidden">
            {rows.map((p) => (
              <Card key={`${p.kind}-${p.id}`}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">
                      {t(`paymentKinds.${p.kind}` as Parameters<typeof t>[0])}
                    </span>
                    <StatusBadge status={p.status} label={tPay(p.status as Parameters<typeof tPay>[0])} />
                  </div>
                  <p className="font-mono text-xs" dir="ltr">
                    {p.provider}
                    {p.amountMinor != null && p.currency
                      ? ` · ${formatMinor(p.amountMinor, p.currency)}`
                      : ""}
                  </p>
                  <p className="text-muted-foreground text-xs">{formatDateTime(p.createdAt)}</p>
                  {p.kind === "checkout_session" ? (
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setReverifyTarget(p)}>
                        <RefreshCw className="size-3.5" aria-hidden="true" />
                        {t("payments.reverify")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setInvestigateTarget(p)}>
                        <Search className="size-3.5" aria-hidden="true" />
                        {t("payments.investigate")}
                      </Button>
                    </div>
                  ) : null}
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

      {reverifyTarget ? (
        <PaymentReverifyDialog
          target={reverifyTarget}
          onClose={() => setReverifyTarget(null)}
        />
      ) : null}
      {investigateTarget ? (
        <InvestigationDialog
          target={investigateTarget}
          onClose={() => setInvestigateTarget(null)}
        />
      ) : null}
      {/* keep sessions referenced for future filters */}
      <span className="hidden">{sessions.length}</span>
    </div>
  );
}

function PaymentReverifyDialog({ target, onClose }: { target: PlatformPayment; onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <ReauthDialog
      open
      onOpenChange={(open) => !open && onClose()}
      titleKey="dialogs.reverifyTitle"
      descriptionKey="dialogs.reverifyBody"
      values={{ provider: target.provider, status: target.status }}
      submitting={submitting}
      error={error}
      onSubmit={({ reason, password }) => {
        setSubmitting(true);
        setError(null);
        platformMutations
          .reverifyPayment(target.id, { reason, password })
          .then((res) => {
            toast.success(t("payments.reverifySuccess", { verification: res.verification }));
            void queryClient.invalidateQueries({ queryKey: ["platform", "payments"] });
            onClose();
          })
          .catch((e) => setError(tError(e)))
          .finally(() => setSubmitting(false));
      }}
    />
  );
}

function InvestigationDialog({ target, onClose }: { target: PlatformPayment; onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <ReauthDialog
      open
      onOpenChange={(open) => !open && onClose()}
      titleKey="dialogs.investigateTitle"
      descriptionKey="dialogs.investigateBody"
      submitting={submitting}
      error={error}
      note
      onSubmit={({ reason, password, note }) => {
        setSubmitting(true);
        setError(null);
        platformMutations
          .recordInvestigation(target.id, {
            reason,
            password,
            reviewStatus: "UNDER_REVIEW",
            ...(typeof note === "string" && note ? { note } : {}),
          })
          .then(() => {
            toast.success(t("payments.investigateSuccess"));
            void queryClient.invalidateQueries({ queryKey: ["platform", "payments"] });
            onClose();
          })
          .catch((e) => setError(tError(e)))
          .finally(() => setSubmitting(false));
      }}
    />
  );
}

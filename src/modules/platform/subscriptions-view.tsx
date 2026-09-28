"use client";

/**
 * Platform subscriptions (§24-§29): read-only list for every role with
 * platform:subscriptions:read; pause/resume/plan-change/trial operations
 * for platform:subscriptions:manage — each through the EXISTING billing
 * service (state machine enforced server-side), each requiring reason +
 * reauthentication, each audited (§34/§56). The UI can never fabricate a
 * payment success and never bypass the state machine (§24/§31).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pause, Play, Repeat, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { platformMutations, platformQueries, type PlatformSubscription } from "./platform-api";
import {
  EmptyState,
  ListSkeleton,
  PaginationBar,
  ReauthDialog,
  StatusBadge,
  formatDateTime,
  usePlatformErrorText,
} from "./kit";

const PAGE_SIZE = 20;
const STATUSES = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED", "PAUSED"];
const PLANS = ["FREE", "STARTER", "BUSINESS", "PRO", "ENTERPRISE"];

export type SubOpKind = "pause" | "resume" | "plan" | "trial-start" | "trial-end";

export function SubscriptionsView() {
  const t = useTranslations("platform");
  const tSub = useTranslations("platform.subscriptionStatus");
  const [status, setStatus] = React.useState<string>("");
  const [plan, setPlan] = React.useState<string>("");
  const [page, setPage] = React.useState(1);
  const [opTarget, setOpTarget] = React.useState<{ sub: PlatformSubscription; op: SubOpKind } | null>(null);

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (plan) params.set("plan", plan);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "subscriptions", params.toString()],
    queryFn: () => platformQueries.subscriptions(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows = data?.subscriptions ?? [];

  const opButtons = (sub: PlatformSubscription) => (
    <div className="flex flex-wrap gap-1">
      {sub.status === "ACTIVE" ? (
        <Button variant="outline" size="sm" onClick={() => setOpTarget({ sub, op: "pause" })}>
          <Pause className="size-3.5" aria-hidden="true" />
          {t("subscriptions.pause")}
        </Button>
      ) : null}
      {sub.status === "PAUSED" ? (
        <Button variant="outline" size="sm" onClick={() => setOpTarget({ sub, op: "resume" })}>
          <Play className="size-3.5" aria-hidden="true" />
          {t("subscriptions.resume")}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => setOpTarget({ sub, op: "plan" })}>
        <Repeat className="size-3.5" aria-hidden="true" />
        {t("subscriptions.planChange")}
      </Button>
      {sub.status !== "TRIALING" ? (
        <Button variant="outline" size="sm" onClick={() => setOpTarget({ sub, op: "trial-start" })}>
          <FlaskConical className="size-3.5" aria-hidden="true" />
          {t("subscriptions.trialStart")}
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpTarget({ sub, op: "trial-end" })}>
          <FlaskConical className="size-3.5" aria-hidden="true" />
          {t("subscriptions.trialEnd")}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pf-sub-status">{t("subscriptions.filterStatus")}</Label>
            <Select
              value={status || "all"}
              onValueChange={(v) => {
                setStatus(v === "all" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger id="pf-sub-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {tSub(s as Parameters<typeof tSub>[0])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-sub-plan">{t("subscriptions.filterPlan")}</Label>
            <Select
              value={plan || "all"}
              onValueChange={(v) => {
                setPlan(v === "all" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger id="pf-sub-plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                {PLANS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("subscriptions.empty")} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("subscriptions.business")}</TableHead>
                  <TableHead>{t("subscriptions.plan")}</TableHead>
                  <TableHead>{t("subscriptions.status")}</TableHead>
                  <TableHead>{t("subscriptions.periodEnd")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{s.businessName}</div>
                      <div className="text-muted-foreground font-mono text-xs" dir="ltr">
                        {s.businessId}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="font-mono">{s.planCode}</div>
                      <div className="text-muted-foreground text-xs">{s.billingPeriod}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={s.status} label={tSub(s.status as Parameters<typeof tSub>[0])} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {s.currentPeriodEnd ? formatDateTime(s.currentPeriodEnd) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">{opButtons(s)}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 md:hidden">
            {rows.map((s) => (
              <Card key={s.id}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{s.businessName}</span>
                    <StatusBadge status={s.status} label={tSub(s.status as Parameters<typeof tSub>[0])} />
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">
                    {s.planCode} · {s.billingPeriod}
                  </p>
                  {opButtons(s)}
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

      {opTarget ? (
        <SubOperationDialog
          sub={opTarget.sub}
          op={opTarget.op}
          onClose={() => setOpTarget(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The operation dialog. PAUSE requires the typed confirmation
 * "PAUSE SUBSCRIPTION" (§95). The plan operation embeds a plan selector —
 * the server re-validates the code and the state machine transition.
 */
function SubOperationDialog({ sub, op, onClose }: { sub: PlatformSubscription; op: SubOpKind; onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [planTarget, setPlanTarget] = React.useState(sub.planCode);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const typedConfirmation = op === "pause" ? { expected: "PAUSE SUBSCRIPTION" } : undefined;

  const titleKey = (
    op === "pause"
      ? "dialogs.pauseTitle"
      : op === "resume"
        ? "dialogs.resumeTitle"
        : op === "plan"
          ? "dialogs.planTitle"
          : op === "trial-start"
            ? "dialogs.trialStartTitle"
            : "dialogs.trialEndTitle"
  ) as Parameters<typeof t>[0];

  const descriptionKey = (
    op === "pause"
      ? "dialogs.pauseBody"
      : op === "resume"
        ? "dialogs.resumeBody"
        : "dialogs.genericBody"
  ) as Parameters<typeof t>[0];

  const run = async ({ reason, password }: { reason: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      if (op === "pause") {
        await platformMutations.pauseSubscription(sub.businessId, { reason, password });
      } else if (op === "resume") {
        await platformMutations.resumeSubscription(sub.businessId, { reason, password });
      } else if (op === "plan") {
        await platformMutations.changePlan(sub.businessId, { planCode: planTarget, reason, password });
      } else if (op === "trial-start") {
        await platformMutations.trial(sub.businessId, { action: "start", reason, password });
      } else {
        await platformMutations.trial(sub.businessId, { action: "end", reason, password });
      }
      toast.success(t("subscriptions.opSuccess"));
      void queryClient.invalidateQueries({ queryKey: ["platform", "subscriptions"] });
      void queryClient.invalidateQueries({ queryKey: ["platform", "overview"] });
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (op === "plan") {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialogs.planTitle", { business: sub.businessName })}</DialogTitle>
            <DialogDescription>{t("dialogs.planBody", { plan: sub.planCode })}</DialogDescription>
          </DialogHeader>
          {!customOpen ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="pf-plan-target">{t("subscriptions.newPlan")}</Label>
                <Select value={planTarget} onValueChange={setPlanTarget}>
                  <SelectTrigger id="pf-plan-target">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLANS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-muted-foreground text-xs">{t("dialogs.planHint")}</p>
            </div>
          ) : null}
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={planTarget === sub.planCode}
              onClick={() => setCustomOpen(true)}
            >
              {t("subscriptions.continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <ReauthDialog
      open
      onOpenChange={(open) => !open && onClose()}
      titleKey={titleKey}
      descriptionKey={descriptionKey}
      values={{ business: sub.businessName, plan: sub.planCode, status: sub.status }}
      typedConfirmation={typedConfirmation}
      submitting={submitting}
      error={error}
      onSubmit={(p) => void run({ reason: p.reason, password: p.password })}
    />
  );
}

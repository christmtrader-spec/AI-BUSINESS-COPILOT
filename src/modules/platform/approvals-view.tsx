"use client";

/**
 * Two-person approval queue — Prompt 65 §10 (R65-UI).
 *
 * Read + act surface over /platform/approvals. The UI NEVER decides who may
 * approve: action visibility mirrors the server's own gates by permission
 * (platform:approvals:manage + the operation's platform:pricing:manage) and
 * by requester identity (Cancel is requester-only; self-approval is refused
 * server-side and never offered). Requester/approver emails render mono
 * dir=ltr; the payload hash shows as the server's 12-hex correlation prefix
 * only. Execution failures arrive as 409 PLATFORM_EXECUTION_FAILED with a
 * VALUE-FREE errorCode (details.errorCode) — rendered as a destructive
 * inline alert while the row stays retryable until expiry (§10.1).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Check, Loader2, OctagonX, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  APPROVAL_STATUSES,
  platformMutations,
  platformQueries,
  type PlatformApproval,
} from "./platform-api";
import {
  EmptyState,
  Field,
  ListSkeleton,
  PaginationBar,
  formatDateTime,
  usePlatformErrorText,
} from "./kit";
import { isPlatformSelf, usePlatformSelf } from "./use-platform-self";

const PAGE_SIZE = 20;

/** R69 — kind filter options come from the SERVER registry (the approvals
 * list response carries `kinds: APPROVAL_KINDS`); the view never hardcodes
 * authorization data (§5 law — the same source the enforcement chain uses). */

/**
 * Status → badge tone (Prompt 65 §10 honesty law): PENDING amber,
 * APPROVED/EXECUTED quiet emerald, REJECTED/CANCELLED/EXPIRED muted,
 * FAILED destructive, EXECUTING muted with a spinner hint. Labels come
 * from i18n; the token itself is never the only carrier (icon/text rule).
 */
const STATUS_TONE_CLASS: Record<string, string> = {
  PENDING: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  APPROVED: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  EXECUTED: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  REJECTED: "border-border bg-muted text-muted-foreground",
  CANCELLED: "border-border bg-muted text-muted-foreground",
  EXPIRED: "border-border bg-muted text-muted-foreground",
  FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
  EXECUTING: "border-border bg-muted text-muted-foreground",
};

function ApprovalStatusBadge({ status, label }: { status: string; label: string }) {
  const tone = STATUS_TONE_CLASS[status] ?? "border-border bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`${tone} gap-1 whitespace-nowrap`}>
      {status === "EXECUTING" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : null}
      {label}
    </Badge>
  );
}

export function ApprovalsView() {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();
  const queryClient = useQueryClient();
  const { status: sessionStatus } = useSession();
  const self = usePlatformSelf(sessionStatus === "authenticated");
  // R65 — narrow the probe union before reading permissions/identity.
  const selfData = isPlatformSelf(self.data) ? self.data : null;
  const canManage = !!selfData?.permissions.includes("platform:approvals:manage");
  const canPricing = !!selfData?.permissions.includes("platform:pricing:manage");
  const selfOperatorId = selfData?.operatorId ?? null;

  const [statusFilter, setStatusFilter] = React.useState("");
  const [kindFilter, setKindFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const params = new URLSearchParams();
  if (statusFilter) params.set("status", statusFilter);
  if (kindFilter) params.set("kind", kindFilter);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "approvals", params.toString()],
    queryFn: () => platformQueries.approvals(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows: PlatformApproval[] = data?.approvals ?? [];
  // The detail dialog derives its row from the LIVE query data, so an
  // approve/reject/cancel/execute elsewhere re-renders it honestly.
  const detail = detailId ? (rows.find((a) => a.id === detailId) ?? null) : null;

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["platform", "approvals"] });
  }, [queryClient]);

  const resetFilters = React.useCallback(() => {
    setStatusFilter("");
    setKindFilter("");
    setPage(1);
  }, []);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("approvals.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("approvals.description")}</p>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="pf-appr-status">{t("approvals.filterStatus")}</Label>
              <Select
                value={statusFilter || "ALL"}
                onValueChange={(v) => {
                  setStatusFilter(v === "ALL" ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger id="pf-appr-status" aria-label={t("approvals.filterStatus")} className="w-full">
                  <SelectValue placeholder={t("approvals.filterStatusAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("approvals.filterStatusAll")}</SelectItem>
                  {APPROVAL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`approvals.status.${s}` as Parameters<typeof t>[0])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pf-appr-kind">{t("approvals.filterKind")}</Label>
              <Select
                value={kindFilter || "ALL"}
                onValueChange={(v) => {
                  setKindFilter(v === "ALL" ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger id="pf-appr-kind" aria-label={t("approvals.filterKind")} className="w-full">
                  <SelectValue placeholder={t("approvals.filterKindAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("approvals.filterKindAll")}</SelectItem>
                  {(data?.kinds ?? []).map((k) => (
                    <SelectItem key={k} value={k}>
                      <span className="font-mono" dir="ltr">
                        {k}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end gap-2 lg:col-span-2">
              <Button type="button" variant="outline" onClick={resetFilters}>
                {t("security.reset")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("approvals.empty")} />
      ) : (
        <>
          {/* Desktop table — overflow-x-auto wrapper so the 8-column grid
              degrades gracefully at intermediate widths (390px gets cards). */}
          <div className="hidden overflow-x-auto rounded-md border md:block" data-testid="pf-appr-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("approvals.colRequest")}</TableHead>
                  <TableHead>{t("approvals.colStatus")}</TableHead>
                  <TableHead>{t("approvals.colRequester")}</TableHead>
                  <TableHead>{t("approvals.colApprover")}</TableHead>
                  <TableHead>{t("approvals.colReason")}</TableHead>
                  <TableHead>{t("approvals.colHash")}</TableHead>
                  <TableHead>{t("approvals.colCreated")}</TableHead>
                  <TableHead>{t("approvals.colExpires")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow
                    key={a.id}
                    data-testid="pf-appr-row"
                    className="cursor-pointer"
                    onClick={() => setDetailId(a.id)}
                  >
                    <TableCell>
                      <span className="line-clamp-1 max-w-56 text-xs font-medium" dir="ltr" title={a.kindLabel}>
                        {a.kindLabel}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ApprovalStatusBadge
                        status={a.status}
                        label={t(`approvals.status.${a.status}` as Parameters<typeof t>[0])}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs" dir="ltr">
                        {a.requester?.email ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs" dir="ltr">
                        {a.approver?.email ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-52">
                      <span className="line-clamp-1 text-xs" dir="auto" title={a.reason}>
                        {a.reason}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs" dir="ltr">
                        {a.payloadHashPrefix}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDateTime(a.createdAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDateTime(a.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards (390px) — same content, wrap-safe stacking. */}
          <div className="space-y-2 md:hidden" data-testid="pf-appr-cards">
            {rows.map((a) => (
              <Card
                key={a.id}
                className="cursor-pointer py-0 transition-colors hover:bg-accent/40"
                onClick={() => setDetailId(a.id)}
              >
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium" dir="ltr" title={a.kindLabel}>
                      {a.kindLabel}
                    </span>
                    <ApprovalStatusBadge
                      status={a.status}
                      label={t(`approvals.status.${a.status}` as Parameters<typeof t>[0])}
                    />
                  </div>
                  <p className="line-clamp-2 text-sm" dir="auto">
                    {a.reason}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs">
                    <span className="font-mono text-muted-foreground" dir="ltr">
                      {a.requester?.email ?? "—"}
                    </span>
                    <span className="font-mono text-muted-foreground" dir="ltr">
                      {a.payloadHashPrefix}
                    </span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    <span>{formatDateTime(a.createdAt)}</span>
                    <span>{formatDateTime(a.expiresAt)}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <PaginationBar
            page={data?.meta.page ?? 1}
            hasNext={data?.meta.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

      <ApprovalDetailDialog
        approval={detail}
        selfOperatorId={selfOperatorId}
        canManage={canManage}
        canPricing={canPricing}
        onClose={() => setDetailId(null)}
        onChanged={refresh}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail dialog — full reason, structured payload, both parties, timestamps   */
/* and the audited decision artifacts. Actions are rendered by permission +    */
/* status + requester identity (the server re-verifies every one of them).     */
/* -------------------------------------------------------------------------- */

function ApprovalDetailDialog({
  approval,
  selfOperatorId,
  canManage,
  canPricing,
  onClose,
  onChanged,
}: {
  approval: PlatformApproval | null;
  selfOperatorId: string | null;
  canManage: boolean;
  canPricing: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();
  const [dialog, setDialog] = React.useState<"approve" | "reject" | "cancel" | "execute" | null>(null);

  // Exit-animation safety: remember the last non-null approval so the header
  // still formats while Radix unmounts (same pattern as kit.ReauthDialog).
  const [last, setLast] = React.useState<PlatformApproval | null>(null);
  if (approval !== null && approval !== last) setLast(approval);
  const view = approval ?? last;

  // Server-side rules mirrored for RENDERING only: a PENDING request can be
  // approved/rejected by a second operator holding BOTH permissions; cancel
  // belongs to the requester alone; execution needs both permissions too.
  const isRequester = !!view?.requester && view.requester.id === selfOperatorId;
  const canDecide = canManage && canPricing;
  const showApproveReject = view?.status === "PENDING" && canDecide && !isRequester;
  const showCancel = view?.status === "PENDING" && isRequester;
  const showExecute =
    (view?.status === "APPROVED" || view?.status === "FAILED") && canDecide;

  const priceBookId =
    view?.payload && typeof view.payload === "object" && !Array.isArray(view.payload)
      ? (view.payload as Record<string, unknown>).priceBookId
      : null;

  return (
    <>
      <Dialog
        open={!!approval}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            onClose();
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="pf-appr-detail">
          {view ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("approvals.dTitle")}</DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-2">
                  <ApprovalStatusBadge
                    status={view.status}
                    label={t(`approvals.status.${view.status}` as Parameters<typeof t>[0])}
                  />
                  <span className="font-mono text-xs" dir="ltr">
                    {view.kind}
                  </span>
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <p className="rounded-md border p-3 text-sm break-words" dir="auto">
                  {view.reason}
                </p>

                {view.status === "PENDING" && isRequester ? (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <span aria-hidden="true">›</span>
                    {t("approvals.dSelfPending")}
                  </p>
                ) : null}

                <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label={t("approvals.dPayload")}>
                    {priceBookId != null ? (
                      <span className="font-mono text-xs break-all" dir="ltr">
                        priceBookId: {String(priceBookId)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </Field>
                  <Field label={t("approvals.dPayloadHash")}>
                    <span className="font-mono text-xs break-all" dir="ltr">
                      {view.payloadHashPrefix}
                    </span>
                  </Field>
                  <Field label={t("approvals.dRequestedBy")}>
                    {view.requester ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs" dir="ltr">
                          {view.requester.email ?? "—"}
                        </span>
                        <Badge variant="outline">
                          {t(`roles.${view.requester.role}` as Parameters<typeof t>[0])}
                        </Badge>
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </Field>
                  <Field label={t("approvals.dApprovedBy")}>
                    {view.approver ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs" dir="ltr">
                          {view.approver.email ?? "—"}
                        </span>
                        <Badge variant="outline">
                          {t(`roles.${view.approver.role}` as Parameters<typeof t>[0])}
                        </Badge>
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">{t("approvals.dNoApprover")}</span>
                    )}
                  </Field>
                  <Field label={t("approvals.dCreated")}>{formatDateTime(view.createdAt)}</Field>
                  <Field label={t("approvals.dExpires")}>{formatDateTime(view.expiresAt)}</Field>
                  {view.approvedAt ? (
                    <Field label={t("approvals.dApprovedAt")}>{formatDateTime(view.approvedAt)}</Field>
                  ) : null}
                  {view.executedAt ? (
                    <Field label={t("approvals.dExecutedAt")}>{formatDateTime(view.executedAt)}</Field>
                  ) : null}
                  {view.approvalNote ? (
                    <Field label={t("approvals.dNote")}>
                      <span className="break-words" dir="auto">
                        {view.approvalNote}
                      </span>
                    </Field>
                  ) : null}
                  {view.rejectionReason ? (
                    <Field label={t("approvals.dRejection")}>
                      <span className="break-words" dir="auto">
                        {view.rejectionReason}
                      </span>
                    </Field>
                  ) : null}
                  {view.executeError ? (
                    <Field label={t("approvals.dExecError")}>
                      <span className="text-destructive font-mono text-xs break-all" dir="ltr">
                        {view.executeError}
                      </span>
                    </Field>
                  ) : null}
                </dl>
              </div>

              <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  {showApproveReject ? (
                    <>
                      <Button
                        size="sm"
                        data-testid="pf-appr-approve"
                        onClick={() => setDialog("approve")}
                      >
                        <Check className="size-4" aria-hidden="true" />
                        {t("approvals.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-destructive/40 text-destructive hover:bg-destructive/10"
                        data-testid="pf-appr-reject"
                        onClick={() => setDialog("reject")}
                      >
                        <OctagonX className="size-4" aria-hidden="true" />
                        {t("approvals.reject")}
                      </Button>
                    </>
                  ) : null}
                  {showExecute ? (
                    <Button size="sm" data-testid="pf-appr-execute" onClick={() => setDialog("execute")}>
                      <Play className="size-4" aria-hidden="true" />
                      {t("approvals.execute")}
                    </Button>
                  ) : null}
                  {showCancel ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10"
                      data-testid="pf-appr-cancel"
                      onClick={() => setDialog("cancel")}
                    >
                      <OctagonX className="size-4" aria-hidden="true" />
                      {t("approvals.cancel")}
                    </Button>
                  ) : null}
                </div>
                <Button variant="outline" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {dialog === "approve" && approval ? (
        <ApproveDialog
          approval={approval}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
      {dialog === "reject" && approval ? (
        <RejectDialog
          approval={approval}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
      {dialog === "cancel" && approval ? (
        <CancelDialog
          approval={approval}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
      {dialog === "execute" && approval ? (
        <ExecuteDialog
          approval={approval}
          errorText={errorText}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
    </>
  );
}

/* ------------------------------- approve ---------------------------------- */

/** Approve — the SECOND person confirms. Note is OPTIONAL (≤300, audited). */
function ApproveDialog({
  approval,
  onClose,
  onDone,
}: {
  approval: PlatformApproval;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.approveApproval(approval.id, note.trim() ? { note: note.trim() } : {});
      toast.success(t("approvals.aSuccess"));
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pf-appr-approve-dialog">
        <DialogHeader>
          <DialogTitle>{t("approvals.aTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.aDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pf-appr-note">{t("dialogs.note")}</Label>
            <Textarea
              id="pf-appr-note"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 300))}
              rows={2}
              maxLength={300}
            />
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button disabled={submitting} onClick={() => void submit()}>
            {submitting ? t("common.working") : t("approvals.aConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- reject ---------------------------------- */

/** Reject — permanent + audited; the reason is MANDATORY (3..300, §10.1). */
function RejectDialog({
  approval,
  onClose,
  onDone,
}: {
  approval: PlatformApproval;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSubmit = reason.trim().length >= 3 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.rejectApproval(approval.id, { reason: reason.trim() });
      toast.success(t("approvals.rSuccess"));
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pf-appr-reject-dialog">
        <DialogHeader>
          <DialogTitle>{t("approvals.rTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.rDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pf-appr-reject-reason">{t("dialogs.reason")}</Label>
            <Textarea
              id="pf-appr-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 300))}
              rows={2}
              maxLength={300}
              placeholder={t("dialogs.reasonPlaceholder")}
              aria-describedby="pf-appr-reject-counter"
            />
            <p id="pf-appr-reject-counter" className="text-muted-foreground text-xs tabular-nums">
              {reason.length}/300
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? t("common.working") : t("approvals.rConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- cancel ---------------------------------- */

/** Cancel — the REQUESTER withdraws their own still-pending request. */
function CancelDialog({
  approval,
  onClose,
  onDone,
}: {
  approval: PlatformApproval;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.cancelApproval(approval.id);
      toast.success(t("approvals.cSuccess"));
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pf-appr-cancel-dialog">
        <DialogHeader>
          <DialogTitle>{t("approvals.cTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.cDesc")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={submitting} onClick={() => void submit()}>
            {submitting ? t("common.working") : t("approvals.cConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- execute --------------------------------- */

/**
 * Execute — runs the approved operation exactly once (§10.1). The current
 * password is REQUIRED (server assertPlatformReauth 403s without it).
 * PLATFORM_EXECUTION_FAILED (409) renders as a destructive inline alert
 * carrying ONLY the value-free errorCode; the row stays retryable until
 * expiry, so the dialog stays open for an honest retry.
 */
function ExecuteDialog({
  approval,
  errorText,
  onClose,
  onDone,
}: {
  approval: PlatformApproval;
  errorText: (e: unknown) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("platform");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [failureCode, setFailureCode] = React.useState<string | null>(null);

  const canSubmit = password.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.executeApproval(approval.id, { password });
      toast.success(t("approvals.xSuccess"));
      onDone();
      onClose();
    } catch (e) {
      const code =
        e instanceof Error && "code" in e && typeof (e as { code: unknown }).code === "string"
          ? (e as { code: string }).code
          : null;
      if (code === "PLATFORM_EXECUTION_FAILED") {
        // Honest failure: the operation did NOT happen; show the sanitized
        // errorCode from the server's details and keep the dialog usable.
        const details = (e as { details?: { errorCode?: unknown } }).details;
        setFailureCode(
          details && typeof details.errorCode === "string" ? details.errorCode : null,
        );
        onDone(); // status flipped to FAILED — refresh the underlying row
        setSubmitting(false);
        return;
      }
      setError(errorText(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pf-appr-exec-dialog">
        <DialogHeader>
          <DialogTitle>{t("approvals.xTitle")}</DialogTitle>
          <DialogDescription>{t("approvals.xDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {failureCode ? (
            <div
              role="alert"
              data-testid="pf-appr-exec-error"
              className="border-destructive/40 bg-destructive/10 space-y-1 rounded-md border p-3"
            >
              <p className="text-destructive text-sm font-medium">{t("approvals.xFailed")}</p>
              <p className="text-muted-foreground text-xs">
                {t("approvals.xErrorCode")}:{" "}
                <span className="text-destructive font-mono break-all" dir="ltr">
                  {failureCode}
                </span>
              </p>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="pf-appr-exec-password">{t("dialogs.currentPassword")}</Label>
            <Input
              id="pf-appr-exec-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <p className="text-muted-foreground text-xs">{t("approvals.xExpiry", { time: formatDateTime(approval.expiresAt) })}</p>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? t("common.working") : t("approvals.xConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

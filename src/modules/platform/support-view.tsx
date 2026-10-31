"use client";

/**
 * Platform Support Center (§10) — ticket list, thread, transitions,
 * resolution workflow and bounded diagnostics.
 *
 * UI laws carried over from the Prompt-28 console: permission-gated actions
 * (hidden, not disabled — §87), explicit loading/empty/error states, EN/FA +
 * RTL + dark via the existing primitives, table on desktop / cards on mobile.
 * INTERNAL notes are visually distinct (amber) and exist ONLY in this
 * operator surface — the tenant API can never return them (§10.2).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, CheckCheck, LifeBuoy, MessageSquarePlus, Search, UserCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  platformMutations,
  platformQueries,
  type PlatformSupportTicket,
  type PlatformSupportTicketDetail,
  type PlatformTicketDiagnostics,
  type PlatformTicketViewer,
} from "./platform-api";
import { EmptyState, ListSkeleton, PaginationBar, StatusBadge, formatDateTime, usePlatformErrorText } from "./kit";

const PAGE_SIZE = 20;

export function SupportView() {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();

  const [status, setStatus] = React.useState("");
  const [priority, setPriority] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openTicketId, setOpenTicketId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const hasFilters = !!(status || priority || category || assignee || q);

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  if (category) params.set("category", category);
  if (assignee) params.set("assignee", assignee);
  if (q) params.set("q", q);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "support-tickets", params.toString()],
    queryFn: () => platformQueries.supportTickets(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows: PlatformSupportTicket[] = data?.tickets ?? [];
  const facets = data?.facets;

  const clearFilters = () => {
    setStatus("");
    setPriority("");
    setCategory("");
    setAssignee("");
    setQ("");
    setPage(1);
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["platform", "support-tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["platform", "support-ticket"] });
    void queryClient.invalidateQueries({ queryKey: ["platform", "overview"] });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-status">{t("support.filterStatus")}</Label>
            <Select value={status} onValueChange={(v) => { setStatus(v === "ALL" ? "" : v); setPage(1); }}>
              <SelectTrigger id="pf-sup-status" aria-label={t("support.filterStatus")}>
                <SelectValue placeholder={t("support.filterAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("support.filterAll")}</SelectItem>
                {(facets?.statuses ?? []).map((s) => (
                  <SelectItem key={s} value={s}>{t(`support.status.${s}` as Parameters<typeof t>[0])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-priority">{t("support.filterPriority")}</Label>
            <Select value={priority} onValueChange={(v) => { setPriority(v === "ALL" ? "" : v); setPage(1); }}>
              <SelectTrigger id="pf-sup-priority" aria-label={t("support.filterPriority")}>
                <SelectValue placeholder={t("support.filterAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("support.filterAll")}</SelectItem>
                {(facets?.priorities ?? []).map((p) => (
                  <SelectItem key={p} value={p}>{t(`support.priority.${p}` as Parameters<typeof t>[0])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-category">{t("support.filterCategory")}</Label>
            <Select value={category} onValueChange={(v) => { setCategory(v === "ALL" ? "" : v); setPage(1); }}>
              <SelectTrigger id="pf-sup-category" aria-label={t("support.filterCategory")}>
                <SelectValue placeholder={t("support.filterAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("support.filterAll")}</SelectItem>
                {(facets?.categories ?? []).map((c) => (
                  <SelectItem key={c} value={c}>{t(`support.category.${c}` as Parameters<typeof t>[0])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-q">{t("support.filterSearch")}</Label>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-2.5 size-4 ltr:left-2.5 rtl:right-2.5" aria-hidden="true" />
              <Input
                id="pf-sup-q"
                className="ltr:pl-8 rtl:pr-8"
                dir="auto"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder={t("support.filterSearchPlaceholder")}
              />
            </div>
          </div>
          <div className="flex items-end gap-2">
            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>{t("support.clearFilters")}</Button>
            ) : null}
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <MessageSquarePlus className="size-4" aria-hidden="true" />
              {t("support.newTicket")}
            </Button>
          </div>
          <div className="md:col-span-4">
            <Label htmlFor="pf-sup-assignee" className="sr-only">{t("support.filterAssignee")}</Label>
            <Select value={assignee} onValueChange={(v) => { setAssignee(v === "ALL" ? "" : v); setPage(1); }}>
              <SelectTrigger id="pf-sup-assignee" aria-label={t("support.filterAssignee")} className="w-full md:w-64">
                <SelectValue placeholder={t("support.filterAllAssignees")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("support.filterAllAssignees")}</SelectItem>
                <SelectItem value="me">{t("support.filterAssignedToMe")}</SelectItem>
                <SelectItem value="unassigned">{t("support.filterUnassigned")}</SelectItem>
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
        <EmptyState label={hasFilters ? t("support.emptyFiltered") : t("support.empty")} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("support.colReference")}</TableHead>
                  <TableHead>{t("support.colSubject")}</TableHead>
                  <TableHead>{t("support.colRequester")}</TableHead>
                  <TableHead>{t("support.colBusiness")}</TableHead>
                  <TableHead>{t("support.colStatus")}</TableHead>
                  <TableHead>{t("support.colPriority")}</TableHead>
                  <TableHead>{t("support.colCreated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((ticket) => (
                  <TableRow
                    key={ticket.id}
                    className="cursor-pointer"
                    onClick={() => setOpenTicketId(ticket.id)}
                  >
                    <TableCell className="font-mono text-xs">{ticket.reference}</TableCell>
                    <TableCell className="max-w-[22rem]">
                      <span className="line-clamp-1 text-sm" dir="auto">{ticket.subject}</span>
                    </TableCell>
                    <TableCell>
                      <span dir="ltr" className="text-xs">{ticket.requesterEmail}</span>
                    </TableCell>
                    <TableCell className="text-sm" dir="auto">{ticket.businessName ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={ticket.status} label={t(`support.status.${ticket.status}` as Parameters<typeof t>[0])} />
                        <SlaBadge verdict={ticket.sla} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={priorityClasses(ticket.priority)}>
                        {t(`support.priority.${ticket.priority}` as Parameters<typeof t>[0])}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(ticket.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 md:hidden">
            {rows.map((ticket) => (
              <Card
                key={ticket.id}
                className="cursor-pointer py-0 transition-colors hover:bg-accent/40 motion-reduce:transition-none"
                onClick={() => setOpenTicketId(ticket.id)}
              >
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{ticket.reference}</span>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <StatusBadge status={ticket.status} label={t(`support.status.${ticket.status}` as Parameters<typeof t>[0])} />
                      <SlaBadge verdict={ticket.sla} />
                    </div>
                  </div>
                  <p className="text-sm font-medium" dir="auto">{ticket.subject}</p>
                  <p className="text-muted-foreground text-xs" dir="ltr">{ticket.requesterEmail}</p>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={priorityClasses(ticket.priority)}>
                      {t(`support.priority.${ticket.priority}` as Parameters<typeof t>[0])}
                    </Badge>
                    <span className="text-muted-foreground text-xs">{formatDateTime(ticket.createdAt)}</span>
                  </div>
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

      <TicketDetailDialog
        ticketId={openTicketId}
        onClose={() => setOpenTicketId(null)}
        onChanged={refresh}
      />
      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          refresh();
          setCreateOpen(false);
          setOpenTicketId(id);
        }}
      />
    </div>
  );
}

function priorityClasses(priority: string): string {
  switch (priority) {
    case "URGENT":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400";
    case "HIGH":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "LOW":
      return "border-muted-foreground/30 bg-muted/40 text-muted-foreground";
    default:
      return "";
  }
}

/**
 * R64 — first-response SLA verdict badge, rendered ONLY for actionable
 * verdicts (overdue / due_soon / met); "open" and "na" stay silent to keep
 * the row quiet. Icon + label always carry the meaning — color is only the
 * accent (§ tone law). Unknown/undefined verdicts (stale cache) render
 * nothing instead of guessing.
 */
function SlaBadge({ verdict }: { verdict: string }) {
  const t = useTranslations("platform");
  if (verdict !== "overdue" && verdict !== "due_soon" && verdict !== "met") return null;
  const classes =
    verdict === "overdue"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : verdict === "due_soon"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  return (
    <Badge variant="outline" className={`${classes} whitespace-nowrap`} data-testid={`pf-sla-${verdict}`}>
      {verdict === "met" ? <Check className="size-3" aria-hidden="true" /> : null}
      {t(`support.sla.${verdict}` as Parameters<typeof t>[0])}
    </Badge>
  );
}

/* ------------------------------ detail dialog ------------------------------ */

function TicketDetailDialog({
  ticketId,
  onClose,
  onChanged,
}: {
  ticketId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "support-ticket", ticketId],
    queryFn: () => platformQueries.supportTicket(ticketId!),
    enabled: !!ticketId,
    refetchOnWindowFocus: false,
  });

  return (
    <Dialog open={!!ticketId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        {isLoading ? (
          <ListSkeleton />
        ) : isError || !data ? (
          <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
        ) : (
          <TicketDetailBody
            ticket={data.ticket}
            diagnostics={data.diagnostics}
            viewer={data.viewer}
            onChanged={onChanged}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TicketDetailBody({
  ticket,
  diagnostics,
  viewer,
  onChanged,
  onClose,
}: {
  ticket: PlatformSupportTicketDetail;
  diagnostics: PlatformTicketDiagnostics;
  viewer: PlatformTicketViewer;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();

  const [reply, setReply] = React.useState("");
  const [visibility, setVisibility] = React.useState<"CUSTOMER" | "INTERNAL">("CUSTOMER");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resolveOpen, setResolveOpen] = React.useState(false);

  const act = async (fn: () => Promise<unknown>, successKey: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(t(successKey));
      onChanged();
    } catch (e) {
      setError(tError(e));
    } finally {
      setBusy(false);
    }
  };

  const sendReply = () => {
    if (!reply.trim()) return;
    void act(async () => {
      await platformMutations.supportMessage(ticket.id, { body: reply, visibility });
      setReply("");
    }, "support.toastReplySent");
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2" dir="auto">
          <span className="font-mono text-sm text-muted-foreground">{ticket.reference}</span>
          {ticket.subject}
        </DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-2">
          <StatusBadge status={ticket.status} label={t(`support.status.${ticket.status}` as Parameters<typeof t>[0])} />
          <Badge variant="outline" className={priorityClasses(ticket.priority)}>
            {t(`support.priority.${ticket.priority}` as Parameters<typeof t>[0])}
          </Badge>
          <Badge variant="outline">{t(`support.category.${ticket.category}` as Parameters<typeof t>[0])}</Badge>
          <span dir="ltr" className="text-xs">{ticket.requesterEmail}</span>
          {ticket.businessName ? <span className="text-xs" dir="auto">· {ticket.businessName}</span> : null}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-1" role="log" aria-label={t("support.threadLabel")}>
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="text-muted-foreground mb-1 text-xs font-medium">{t("support.originalRequest")}</p>
          <p className="whitespace-pre-wrap text-sm" dir="auto">{ticket.description}</p>
        </div>

        {ticket.messages.map((m) => (
          <div
            key={m.id}
            className={
              m.visibility === "INTERNAL"
                ? "rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
                : "rounded-md border p-3"
            }
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={m.authorKind === "OPERATOR" ? "default" : "outline"} className="text-[10px]">
                {m.authorKind === "OPERATOR" ? t("support.authorOperator") : t("support.authorRequester")}
              </Badge>
              {m.visibility === "INTERNAL" ? (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                  {t("support.internalNote")}
                </Badge>
              ) : null}
              <span className="text-muted-foreground text-[11px]">{formatDateTime(m.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm" dir="auto">{m.body}</p>
          </div>
        ))}

        {ticket.status === "RESOLVED" && ticket.resolutionSummary ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
            <p className="mb-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {t("support.resolutionSummaryLabel")}
            </p>
            <p className="whitespace-pre-wrap text-sm" dir="auto">{ticket.resolutionSummary}</p>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">{error}</p>
      ) : null}

      {ticket.status !== "CLOSED" && viewer.canUpdate ? (
        <div className="space-y-2">
          <Label htmlFor="pf-sup-reply">{t("support.replyLabel")}</Label>
          <Textarea
            id="pf-sup-reply"
            rows={3}
            dir="auto"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={visibility === "INTERNAL" ? t("support.replyInternalPlaceholder") : t("support.replyPlaceholder")}
            maxLength={2000}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={visibility} onValueChange={(v) => setVisibility(v as "CUSTOMER" | "INTERNAL")}>
              <SelectTrigger className="w-44" aria-label={t("support.visibilityLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CUSTOMER">{t("support.visibilityCustomer")}</SelectItem>
                <SelectItem value="INTERNAL">{t("support.visibilityInternal")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={busy || !reply.trim()} onClick={sendReply}>
              {t("support.sendReply")}
            </Button>
          </div>
        </div>
      ) : null}

      <Separator />

      <div className="flex flex-wrap items-center gap-2">
        {viewer.canAssign ? (
          ticket.assigneeOperatorId === viewer.operatorId ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void act(() => platformMutations.supportPatchTicket(ticket.id, { assigneeOperatorId: null }), "support.toastUnassigned")}
            >
              <UserX className="size-3.5" aria-hidden="true" />
              {t("support.unassignMe")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void act(() => platformMutations.supportPatchTicket(ticket.id, { assigneeOperatorId: "me" }), "support.toastAssigned")}
            >
              <UserCheck className="size-3.5" aria-hidden="true" />
              {t("support.assignMe")}
            </Button>
          )
        ) : null}

        {viewer.canUpdate ? (
          <Select
            value={ticket.priority}
            onValueChange={(v) =>
              v !== ticket.priority
                ? void act(() => platformMutations.supportPatchTicket(ticket.id, { priority: v }), "support.toastPriority")
                : undefined
            }
          >
            <SelectTrigger className="h-9 w-36" aria-label={t("support.filterPriority")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
                <SelectItem key={p} value={p}>{t(`support.priority.${p}` as Parameters<typeof t>[0])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {viewer.canUpdate
          ? ticket.allowedTransitions
              .filter((s) => s !== "RESOLVED")
              .map((s) => (
                <Button
                  key={s}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => platformMutations.supportPatchTicket(ticket.id, { status: s }), "support.toastStatus")}
                >
                  {t(`support.status.${s}` as Parameters<typeof t>[0])}
                </Button>
              ))
          : null}

        {viewer.canResolve && ticket.status !== "RESOLVED" && ticket.status !== "CLOSED" ? (
          <Button size="sm" disabled={busy} onClick={() => setResolveOpen(true)}>
            <CheckCheck className="size-3.5" aria-hidden="true" />
            {t("support.resolveButton")}
          </Button>
        ) : null}
      </div>

      <Separator />
      <DiagnosticsPanel diagnostics={diagnostics} />

      <ResolveDialog
        open={resolveOpen}
        onOpenChange={setResolveOpen}
        submitting={busy}
        onSubmit={(summary) => {
          void act(async () => {
            await platformMutations.supportResolve(ticket.id, { resolutionSummary: summary });
            setResolveOpen(false);
            onClose();
          }, "support.toastResolved");
        }}
      />
    </div>
  );
}

function ResolveDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onSubmit: (summary: string) => void;
}) {
  const t = useTranslations("platform");
  const [summary, setSummary] = React.useState("");
  React.useEffect(() => {
    if (open) setSummary("");
  }, [open]);
  const ok = summary.trim().length >= 10 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("support.resolveTitle")}</DialogTitle>
          <DialogDescription>{t("support.resolveDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-resolution">{t("support.resolutionSummaryLabel")}</Label>
            <Textarea
              id="pf-sup-resolution"
              rows={4}
              dir="auto"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={2000}
            />
            {summary.trim().length > 0 && summary.trim().length < 10 ? (
              <p className="text-destructive text-xs">{t("support.resolutionTooShort")}</p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={!ok} onClick={() => onSubmit(summary.trim())}>
              {t("support.resolveConfirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------- diagnostics ------------------------------- */

function DiagnosticsPanel({ diagnostics }: { diagnostics: PlatformTicketDiagnostics }) {
  const t = useTranslations("platform");
  return (
    <Card className="border-dashed py-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LifeBuoy className="size-4" aria-hidden="true" />
          {t("support.diagnosticsTitle")}
        </CardTitle>
        <CardDescription className="text-xs">{t("support.diagnosticsDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <p className="text-muted-foreground mb-1 font-medium">{t("support.diagSubscription")}</p>
          {diagnostics.subscription ? (
            <p>
              {diagnostics.subscription.planName ?? "—"} ·{" "}
              <StatusBadge
                status={diagnostics.subscription.status}
                label={diagnostics.subscription.status}
              />{" "}
              {diagnostics.subscription.currentPeriodEnd
                ? `· ${formatDateTime(diagnostics.subscription.currentPeriodEnd)}`
                : ""}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("support.diagNoBusiness")}</p>
          )}
        </div>
        <div>
          <p className="text-muted-foreground mb-1 font-medium">{t("support.diagRequesterTickets")}</p>
          <p className="tabular-nums">{t("support.diagTicketCount", { count: diagnostics.requester.totalTickets })}</p>
          {diagnostics.requester.recentTickets.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {diagnostics.requester.recentTickets.slice(0, 3).map((rt) => (
                <li key={rt.id} className="text-muted-foreground truncate" dir="auto">
                  SUP-{String(rt.number).padStart(4, "0")} · {rt.subject} · {t(`support.status.${rt.status}` as Parameters<typeof t>[0])}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <p className="text-muted-foreground mb-1 font-medium">{t("support.diagFailedDeliveries")}</p>
          {diagnostics.failedDeliveries.length === 0 ? (
            <p className="text-muted-foreground">{t("support.diagNone")}</p>
          ) : (
            <ul className="space-y-0.5">
              {diagnostics.failedDeliveries.map((d, i) => (
                <li key={i} className="text-muted-foreground">
                  {d.notificationType} · {d.channel} · {d.failureCode ?? "FAILED"} · {formatDateTime(d.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
        {diagnostics.securityEvents ? (
          <div>
            <p className="text-muted-foreground mb-1 font-medium">{t("support.diagSecurityEvents")}</p>
            {diagnostics.securityEvents.length === 0 ? (
              <p className="text-muted-foreground">{t("support.diagNone")}</p>
            ) : (
              <ul className="space-y-0.5">
                {diagnostics.securityEvents.map((s, i) => (
                  <li key={i} className="text-muted-foreground">
                    {s.eventType} · {s.success ? "✓" : "✗"} · {formatDateTime(s.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ create dialog ------------------------------ */

function CreateTicketDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ticketId: string) => void;
}) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();

  const [email, setEmail] = React.useState("");
  const [matches, setMatches] = React.useState<Array<{ id: string; email: string; name: string | null }>>([]);
  const [requesterId, setRequesterId] = React.useState("");
  const [businessId, setBusinessId] = React.useState("");
  const [businessQuery, setBusinessQuery] = React.useState("");
  const [businessMatches, setBusinessMatches] = React.useState<Array<{ id: string; name: string }>>([]);
  const [subject, setSubject] = React.useState("");
  const [category, setCategory] = React.useState("TECHNICAL");
  const [priority, setPriority] = React.useState("NORMAL");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Requester lookup — reuses the EXISTING platform users search (§21).
  React.useEffect(() => {
    if (!open) return;
    const emailTrim = email.trim();
    if (emailTrim.length < 3) {
      setMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      platformQueries.users(`email=${encodeURIComponent(emailTrim)}&pageSize=5`)
        .then((d) => setMatches(d.users.map((u) => ({ id: u.id, email: u.email, name: u.name }))))
        .catch(() => setMatches([]));
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [email, open]);

  // Optional business attach — reuses the EXISTING platform businesses search.
  React.useEffect(() => {
    if (!open) return;
    const q = businessQuery.trim();
    if (q.length < 2 || businessId) {
      setBusinessMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      platformQueries.businesses(`q=${encodeURIComponent(q)}&pageSize=5`)
        .then((d) => setBusinessMatches(d.businesses.map((b) => ({ id: b.id, name: b.name }))))
        .catch(() => setBusinessMatches([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [businessQuery, businessId, open]);

  React.useEffect(() => {
    if (open) {
      setEmail("");
      setMatches([]);
      setRequesterId("");
      setBusinessId("");
      setBusinessQuery("");
      setBusinessMatches([]);
      setSubject("");
      setCategory("TECHNICAL");
      setPriority("NORMAL");
      setDescription("");
      setError(null);
    }
  }, [open]);

  const canSubmit =
    !!requesterId && subject.trim().length >= 5 && description.trim().length >= 10 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/platform/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          requesterId,
          ...(businessId ? { businessId } : {}),
          subject: subject.trim(),
          description: description.trim(),
          category,
          priority,
        }),
      });
      const body = (await res.json()) as
        | { ok: true; data: { ticket: { id: string } } }
        | { ok: false; error: { code: string; message: string } };
      if (!res.ok || !body.ok) {
        const message =
          body.ok === false ? body.error.message : "Request failed.";
        setError(message || "Request failed.");
        return;
      }
      onCreated(body.data.ticket.id);
    } catch (e) {
      setError(tError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("support.createTitle")}</DialogTitle>
          <DialogDescription>{t("support.createDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-c-email">{t("support.createRequester")}</Label>
            <Input
              id="pf-sup-c-email"
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setRequesterId("");
              }}
              placeholder="user@example.com"
            />
            {matches.length > 0 ? (
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-1">
                {matches.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`w-full rounded px-2 py-1.5 text-start text-xs hover:bg-accent ${requesterId === m.id ? "bg-accent" : ""}`}
                    onClick={() => {
                      setRequesterId(m.id);
                      setEmail(m.email);
                    }}
                  >
                    <span dir="ltr">{m.email}</span>
                    {m.name ? <span className="text-muted-foreground" dir="auto"> — {m.name}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-c-business">{t("support.createBusiness")}</Label>
            <Input
              id="pf-sup-c-business"
              dir="auto"
              value={businessId ? (businessMatches.find((b) => b.id === businessId)?.name ?? "") : businessQuery}
              onChange={(e) => {
                setBusinessId("");
                setBusinessQuery(e.target.value);
              }}
              placeholder={t("support.createBusinessPlaceholder")}
            />
            {businessMatches.length > 0 ? (
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-1">
                {businessMatches.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`w-full rounded px-2 py-1.5 text-start text-xs hover:bg-accent ${businessId === b.id ? "bg-accent" : ""}`}
                    onClick={() => setBusinessId(b.id)}
                    dir="auto"
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-c-subject">{t("support.createSubject")}</Label>
            <Input
              id="pf-sup-c-subject"
              dir="auto"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={140}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pf-sup-c-category">{t("support.filterCategory")}</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="pf-sup-c-category" aria-label={t("support.filterCategory")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["BILLING", "TECHNICAL", "ACCOUNT", "AI_COPILOT", "FEATURE_REQUEST", "OTHER"].map((c) => (
                    <SelectItem key={c} value={c}>{t(`support.category.${c}` as Parameters<typeof t>[0])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-sup-c-priority">{t("support.filterPriority")}</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="pf-sup-c-priority" aria-label={t("support.filterPriority")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
                    <SelectItem key={p} value={p}>{t(`support.priority.${p}` as Parameters<typeof t>[0])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pf-sup-c-desc">{t("support.createDescription")}</Label>
            <Textarea
              id="pf-sup-c-desc"
              rows={4}
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
            />
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-sm">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {t("support.createSubmit")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

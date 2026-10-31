"use client";

/**
 * Tenant Support Center — Prompt 62 (§10, requester surface).
 *
 * The customer side of the ONE ticketing subsystem: open a ticket, follow
 * the thread (CUSTOMER-visibility messages ONLY — internal operator notes
 * are filtered at the service layer and can never reach this component),
 * reply, reopen a resolved ticket by replying.
 *
 * dir="auto" on all user-authored text so Persian and English content is
 * always readable in both locales; badges/statuses use the app locale.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LifeBuoy, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { api } from "@/lib/api-client";

type BusinessLike = { id: string; name: string };

type TicketListItem = {
  id: string;
  number: number;
  reference: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type TicketMessage = {
  id: string;
  authorKind: string;
  authorName: string | null;
  visibility: string;
  body: string;
  createdAt: string;
};

type TicketDetail = TicketListItem & {
  description: string;
  resolutionSummary: string | null;
  messages: TicketMessage[];
};

const PAGE_SIZE = 20;

export function SupportCenterView({ business }: { business: BusinessLike }) {
  const t = useTranslations("support");
  const queryClient = useQueryClient();

  const [page, setPage] = React.useState(1);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["support", "tickets", business.id, page],
    queryFn: () =>
      api<{ tickets: TicketListItem[]; page: { page: number; total: number; hasNext: boolean; hasPrev: boolean } }>(
        `/api/v1/support/tickets?page=${page}&pageSize=${PAGE_SIZE}`,
        { businessId: business.id },
      ),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows = data?.tickets ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["support", "tickets"] });
    void queryClient.invalidateQueries({ queryKey: ["support", "ticket"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" aria-hidden="true" />
          {t("newTicket")}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-md border bg-muted/40" />
          ))}
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-destructive text-sm">{t("error")}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={refresh}>
              {t("retry")}
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
              <LifeBuoy className="size-6 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="text-muted-foreground max-w-sm text-sm">{t("emptyBody")}</p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {t("newTicket")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {rows.map((ticket) => (
              <Card
                key={ticket.id}
                className="cursor-pointer py-0 transition-colors hover:bg-accent/40 motion-reduce:transition-none"
                onClick={() => setOpenId(ticket.id)}
              >
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <span className="font-mono text-xs text-muted-foreground">{ticket.reference}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">
                    {ticket.subject}
                  </span>
                  <Badge variant="outline">{t(`category.${ticket.category}` as Parameters<typeof t>[0])}</Badge>
                  <StatusChip status={ticket.status} />
                  <span className="text-muted-foreground text-xs">{formatWhen(ticket.createdAt)}</span>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={!data?.page.hasPrev} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              {t("prev")}
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("pageOf", { page: data?.page.page ?? 1, total: Math.max(1, Math.ceil((data?.page.total ?? 0) / PAGE_SIZE)) })}
            </span>
            <Button variant="outline" size="sm" disabled={!data?.page.hasNext} onClick={() => setPage((p) => p + 1)}>
              {t("next")}
            </Button>
          </div>
        </>
      )}

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        business={business}
        onCreated={(id) => {
          refresh();
          setCreateOpen(false);
          setOpenId(id);
        }}
      />
      <TicketThreadDialog ticketId={openId} business={business} onClose={() => setOpenId(null)} onChanged={refresh} />
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const t = useTranslations("support");
  const cls =
    status === "RESOLVED"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : status === "CLOSED"
        ? "border-muted-foreground/30 bg-muted/40 text-muted-foreground"
        : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return (
    <Badge variant="outline" className={cls}>
      {t(`status.${status}` as Parameters<typeof t>[0])}
    </Badge>
  );
}

/* ------------------------------ create dialog ------------------------------ */

function CreateTicketDialog({
  open,
  onOpenChange,
  business,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  business: BusinessLike;
  onCreated: (ticketId: string) => void;
}) {
  const t = useTranslations("support");
  const [subject, setSubject] = React.useState("");
  const [category, setCategory] = React.useState("TECHNICAL");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setSubject("");
      setCategory("TECHNICAL");
      setDescription("");
      setError(null);
    }
  }, [open]);

  const canSubmit = subject.trim().length >= 5 && description.trim().length >= 10 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ticket: { id: string } }>("/api/v1/support/tickets", {
        method: "POST",
        businessId: business.id,
        body: JSON.stringify({
          subject: subject.trim(),
          description: description.trim(),
          category,
        }),
      });
      onCreated(res.ticket.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sup-c-subject">{t("createSubject")}</Label>
            <Input
              id="sup-c-subject"
              dir="auto"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={140}
            />
            {subject.length > 0 && subject.trim().length < 5 ? (
              <p className="text-destructive text-xs">{t("createSubjectShort")}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sup-c-category">{t("createCategory")}</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="sup-c-category" aria-label={t("createCategory")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["BILLING", "TECHNICAL", "ACCOUNT", "AI_COPILOT", "FEATURE_REQUEST", "OTHER"].map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`category.${c}` as Parameters<typeof t>[0])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sup-c-desc">{t("createDescription")}</Label>
            <Textarea
              id="sup-c-desc"
              rows={5}
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
            />
            {description.length > 0 && description.trim().length < 10 ? (
              <p className="text-destructive text-xs">{t("createDescriptionShort")}</p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">{error}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ thread dialog ------------------------------ */

function TicketThreadDialog({
  ticketId,
  business,
  onClose,
  onChanged,
}: {
  ticketId: string | null;
  business: BusinessLike;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("support");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["support", "ticket", ticketId],
    queryFn: () => api<{ ticket: TicketDetail }>(`/api/v1/support/tickets/${ticketId}`, { businessId: business.id }),
    enabled: !!ticketId,
    refetchOnWindowFocus: false,
  });

  return (
    <Dialog open={!!ticketId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        {isLoading ? (
          <div className="space-y-2 py-4" aria-hidden="true">
            <div className="h-6 w-2/3 animate-pulse rounded bg-muted/40" />
            <div className="h-24 animate-pulse rounded bg-muted/40" />
          </div>
        ) : isError || !data ? (
          <p className="text-destructive py-6 text-center text-sm">{t("error")}</p>
        ) : (
          <ThreadBody ticket={data.ticket} business={business} onChanged={onChanged} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ThreadBody({
  ticket,
  business,
  onChanged,
}: {
  ticket: TicketDetail;
  business: BusinessLike;
  onChanged: () => void;
}) {
  const t = useTranslations("support");
  const [reply, setReply] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const closed = ticket.status === "CLOSED";

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ message: TicketMessage }>(`/api/v1/support/tickets/${ticket.id}/messages`, {
        method: "POST",
        businessId: business.id,
        body: JSON.stringify({ body: reply.trim() }),
      });
      setReply("");
      toast.success(ticket.status === "RESOLVED" ? t("toastReopened") : t("toastReplySent"));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2" dir="auto">
          <span className="font-mono text-sm text-muted-foreground">{ticket.reference}</span>
          {ticket.subject}
        </DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-2">
          <StatusChip status={ticket.status} />
          <Badge variant="outline">{t(`category.${ticket.category}` as Parameters<typeof t>[0])}</Badge>
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-1" role="log" aria-label={t("threadLabel")}>
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="text-muted-foreground mb-1 text-xs font-medium">{t("originalRequest")}</p>
          <p className="whitespace-pre-wrap text-sm" dir="auto">{ticket.description}</p>
        </div>

        {ticket.messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-md border p-3 ${m.authorKind === "OPERATOR" ? "border-emerald-500/30 bg-emerald-500/5" : ""}`}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={m.authorKind === "OPERATOR" ? "default" : "outline"} className="text-[10px]">
                {m.authorKind === "OPERATOR" ? t("authorSupport") : t("authorYou")}
              </Badge>
              <span className="text-muted-foreground text-[11px]">{formatWhen(m.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm" dir="auto">{m.body}</p>
          </div>
        ))}

        {ticket.status === "RESOLVED" && ticket.resolutionSummary ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
            <p className="mb-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">{t("resolutionSummaryLabel")}</p>
            <p className="whitespace-pre-wrap text-sm" dir="auto">{ticket.resolutionSummary}</p>
            <p className="text-muted-foreground mt-2 text-xs">{t("reopenHint")}</p>
          </div>
        ) : null}
      </div>

      {closed ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">{t("closedNotice")}</p>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="sup-reply">{t("replyLabel")}</Label>
          <Textarea
            id="sup-reply"
            rows={3}
            dir="auto"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            maxLength={2000}
            placeholder={t("replyPlaceholder")}
          />
          {error ? (
            <p role="alert" className="text-destructive text-sm">{error}</p>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" disabled={busy || !reply.trim()} onClick={() => void send()}>
              <Send className="size-3.5" aria-hidden="true" />
              {t("sendReply")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

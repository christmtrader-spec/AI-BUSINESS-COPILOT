"use client";

/**
 * R83/R84 — SaleEditTermsDialog: the invoice terms-lifecycle editor,
 * extracted from the sales-list detail dialog so BOTH sale surfaces speak
 * the exact same law — the sales list dialog AND the entity detail page
 * (#/sales/<id>) reuse this ONE component (one wire contract, one
 * prefill rule, one mirror of the server guards).
 *
 * Three-state payloads (the server's PATCH vocabulary):
 *   dueDate   → untouched when unchanged, null when cleared, value when set.
 *   issueDate → untouched when unchanged, §84 midnoon instant when corrected
 *               (the input self-disables once payments exist — the same 409
 *               law the server enforces, mirrored honestly in the UI).
 *   note      → untouched / null / trimmed value.
 *
 * Prefills use the BUSINESS timezone calendar day (localDayKey) — the same
 * day the aging engine reads, never the raw UTC slice.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CalendarClock, Send } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { localDayKey } from "@/lib/aging";
import type { SaleDetail } from "@/lib/entities";
import type { BusinessSummary } from "../shell/types";

export function SaleEditTermsDialog({
  saleId,
  open,
  onOpenChange,
  business,
  issueMode = false,
  issueDate,
  dueDate,
  note,
  hasPayments,
  onSaved,
}: {
  saleId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  business: BusinessSummary;
  /** R90 — issue mode: the sale is a DRAFT; saving performs the one-way
   *  DRAFT→ISSUED transition (issueDate prefills TODAY's business day —
   *  a draft has no stored issue day to prefill from). */
  issueMode?: boolean;
  /** Current §84/issue instants from the SERVER detail — never client
   *  state. Null on a DRAFT (no issue day exists yet). */
  issueDate: string | null;
  dueDate: string | null;
  note: string | null;
  hasPayments: boolean;
  /** Receives the freshly mapped detail the PATCH returns (same shape as GET). */
  onSaved?: (fresh: SaleDetail) => void;
}) {
  const t = useTranslations("finance.saleDetail");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const [editIssueDate, setEditIssueDate] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editNote, setEditNote] = useState("");

  // Prefill from the current server state on EVERY open — via the
  // render-time adjustment pattern (React's sanctioned derived-state
  // reset; setState inside an effect is forbidden by the hooks lint law).
  // The key pins prefill to (open × sale × server dates), so a stale
  // parent can never seed lies and re-opens always re-read the server.
  const [lastPrefill, setLastPrefill] = useState<string | null>(null);
  const prefillKey = open
    ? `${saleId ?? ""}|${issueMode ? "issue" : "terms"}|${issueDate}|${dueDate ?? ""}|${note ?? ""}`
    : null;
  if (prefillKey !== null && prefillKey !== lastPrefill) {
    setLastPrefill(prefillKey);
    const tz = business.timezone || "UTC";
    // R90 — a draft has no stored issue day: the prefill is TODAY's
    // business day (issue stamps the day you issue, overridable).
    setEditIssueDate(
      issueMode || !issueDate
        ? localDayKey(new Date(), tz)
        : localDayKey(new Date(issueDate), tz),
    );
    setEditDueDate(dueDate ? localDayKey(new Date(dueDate), tz) : "");
    setEditNote(note ?? "");
  }

  const updateTermsMutation = useMutation({
    mutationFn: async (payload: {
      dueDate?: string | null;
      issueDate?: string;
      note?: string | null;
      issue?: boolean;
    }) =>
      api<SaleDetail>(`/api/v1/sales/${saleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: (fresh) => {
      toast({ title: t("termsSavedToast") });
      onSaved?.(fresh);
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  function submitEditTerms() {
    if (!saleId || updateTermsMutation.isPending) return;
    const tz = business.timezone || "UTC";
    const originalIssue = issueDate ? localDayKey(new Date(issueDate), tz) : null;
    const originalDue = dueDate ? localDayKey(new Date(dueDate), tz) : null;
    const payload: {
      dueDate?: string | null;
      issueDate?: string;
      note?: string | null;
      issue?: boolean;
    } = {};
    // R90 — issue mode ALWAYS sends the transition + the stated day (the
    // prefill is today; the user may backdate before issuing).
    if (issueMode) {
      payload.issue = true;
      if (editIssueDate !== "") {
        payload.issueDate = new Date(`${editIssueDate}T12:00:00.000Z`).toISOString();
      }
    }
    // Three-state law: untouched → absent, cleared → null, changed → value.
    if (editDueDate !== (originalDue ?? "")) {
      payload.dueDate = editDueDate === "" ? null : editDueDate;
    }
    if (!issueMode && editIssueDate !== originalIssue && editIssueDate !== "") {
      // §84 midnoon instant — the calendar day is identical in every zone.
      payload.issueDate = new Date(`${editIssueDate}T12:00:00.000Z`).toISOString();
    }
    if (editNote !== (note ?? "")) {
      payload.note = editNote.trim() === "" ? null : editNote.trim();
    }
    updateTermsMutation.mutate(payload);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="sale-edit-terms-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {issueMode ? (
              <Send className="size-4" aria-hidden="true" />
            ) : (
              <CalendarClock className="size-4" aria-hidden="true" />
            )}
            {issueMode ? t("issueTitle") : t("editTermsTitle")}
          </DialogTitle>
          <DialogDescription>
            {issueMode ? t("issueDesc") : t("editTermsDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sale-edit-issue">{t("issueDateLabel")}</Label>
            <Input
              id="sale-edit-issue"
              type="date"
              value={editIssueDate}
              onChange={(e) => setEditIssueDate(e.target.value)}
              disabled={updateTermsMutation.isPending || hasPayments}
              data-testid="sale-edit-issue-input"
            />
            <p className="text-muted-foreground text-xs">
              {issueMode
                ? t("issueDateIssueHint")
                : hasPayments
                  ? t("issueDateLocked")
                  : t("issueDateHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sale-edit-due">{t("dueDate")}</Label>
            <Input
              id="sale-edit-due"
              type="date"
              value={editDueDate}
              onChange={(e) => setEditDueDate(e.target.value)}
              disabled={updateTermsMutation.isPending}
              data-testid="sale-edit-due-input"
            />
            <p className="text-muted-foreground text-xs">{t("dueDateHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sale-edit-note">{t("noteLabel")}</Label>
            <Textarea
              id="sale-edit-note"
              rows={2}
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder={t("notePlaceholder")}
              disabled={updateTermsMutation.isPending}
              data-testid="sale-edit-note-input"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={updateTermsMutation.isPending}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            size="sm"
            onClick={submitEditTerms}
            disabled={updateTermsMutation.isPending || editIssueDate === ""}
            data-testid={issueMode ? "sale-issue-save" : "sale-edit-terms-save"}
          >
            {updateTermsMutation.isPending
              ? tCommon("saving")
              : issueMode
                ? t("issueConfirm")
                : tCommon("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

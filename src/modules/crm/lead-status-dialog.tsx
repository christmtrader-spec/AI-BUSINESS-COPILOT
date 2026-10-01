"use client";

/**
 * Prompt 35 — lead status change dialog (§22/§59).
 *
 * Only transitions from the closed map (constants.LEAD_TRANSITIONS) are
 * offered; CONVERTED is deliberately ABSENT — conversion must use the
 * dedicated atomic flow (§23). Invalid combos never reach the server.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { FormDialog } from "@/components/shared/table-kit";
import { allowedLeadTargets } from "@/lib/crm/constants";
import { type LeadDTO, type LeadStatus } from "@/lib/crm/types";
import { useLeadMutations } from "./crm-api";
import { ApiClientError } from "@/lib/api-client";

export function LeadStatusDialog({
  open,
  onOpenChange,
  lead,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadDTO | null;
  onSaved?: () => void;
}) {
  const t = useTranslations("crm.lead.statusDialog");
  const tStatus = useTranslations("crm.lead.status");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { changeStatus } = useLeadMutations();

  const [target, setTarget] = useState<LeadStatus | "">("");
  const [serverError, setServerError] = useState<string | null>(null);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setTarget("");
    setServerError(null);
  }

  const targets: LeadStatus[] = lead
    ? allowedLeadTargets(lead.status).filter((s) => s !== "CONVERTED")
    : [];
  const valid = target !== "";
  const pending = changeStatus.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !valid || pending) return;
    setServerError(null);
    try {
      await changeStatus.mutateAsync({ id: lead.id, status: target });
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : tErrors("generic"));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
      submitLabel={tCommon("save")}
      cancelLabel={tCommon("cancel")}
      pending={pending}
      disabled={!valid}
      onSubmit={submit}
    >
      <div className="space-y-1.5">
        <Label htmlFor="lead-status-target">{t("target")}</Label>
        <Select value={target || "none"} onValueChange={(v) => setTarget(v === "none" ? "" : (v as LeadStatus))}>
          <SelectTrigger id="lead-status-target" aria-label={t("target")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none" disabled>
              {t("selectStatus")}
            </SelectItem>
            {targets.map((s) => (
              <SelectItem key={s} value={s}>
                {tStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t("convertedNote")}</p>
      </div>
      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

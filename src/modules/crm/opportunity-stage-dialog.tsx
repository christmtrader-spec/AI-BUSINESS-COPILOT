"use client";

/**
 * Prompt 35 — Move Stage dialog (§32/§43/§54/§59).
 *
 * The keyboard/AT-friendly alternative to drag-and-drop (§54): every stage
 * change is an explicit, localized control. LOST requires a reason; the
 * reopen path (WON/LOST → open) is presented in the same closed menu.
 * Probability resets to the target stage default unless the user types one.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormDialog } from "@/components/shared/table-kit";
import { OPPORTUNITY_STAGES, stageCategory, type OpportunityDTO, type OpportunityStage } from "@/lib/crm/types";
import { DEFAULT_STAGE_PROBABILITY, isOpportunityTransitionValid } from "@/lib/crm/constants";
import { useOpportunityMutations } from "./crm-api";
import { ApiClientError } from "@/lib/api-client";

export function OpportunityStageDialog({
  open,
  onOpenChange,
  opportunity,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opportunity: OpportunityDTO | null;
  onSaved?: () => void;
}) {
  const t = useTranslations("crm.opportunity.stageDialog");
  const tStage = useTranslations("crm.opportunity.stage");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { changeStage } = useOpportunityMutations();

  const [stage, setStage] = useState<OpportunityStage>("DISCOVERY");
  const [probability, setProbability] = useState<string>("");
  const [lostReason, setLostReason] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setStage("DISCOVERY");
    setProbability("");
    setLostReason("");
    setServerError(null);
  }

  const from = opportunity?.stage;
  const targetAllowed =
    from !== undefined && from !== stage && isOpportunityTransitionValid(from, stage);
  const needReason = stage === "LOST";
  const reasonValid = !needReason || lostReason.trim().length > 0;
  const probabilityValid =
    probability === "" ||
    (/^\d+$/.test(probability) && Number(probability) >= 0 && Number(probability) <= 100);
  const pending = changeStage.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!opportunity || !targetAllowed || !reasonValid || pending) return;
    setServerError(null);
    try {
      await changeStage.mutateAsync({
        id: opportunity.id,
        stage,
        ...(probability !== "" ? { probabilityPct: Number(probability) } : {}),
        lostReason: needReason ? lostReason.trim() : null,
      });
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
      disabled={!targetAllowed || !reasonValid || !probabilityValid}
      onSubmit={submit}
    >
      <div className="space-y-1.5">
        <Label htmlFor="stage-target">{t("targetStage")}</Label>
        <Select
          value={stage}
          onValueChange={(v) => {
            const next = v as OpportunityStage;
            setStage(next);
            setProbability(String(DEFAULT_STAGE_PROBABILITY[next]));
          }}
        >
          <SelectTrigger id="stage-target" aria-label={t("targetStage")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPPORTUNITY_STAGES.filter(
              (s) => from !== undefined && s !== from && isOpportunityTransitionValid(from, s),
            ).map((s) => (
              <SelectItem key={s} value={s}>
                {tStage(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {from !== undefined && stageCategory(from) !== "OPEN" ? (
          <p className="text-muted-foreground text-xs">{t("reopenNote")}</p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="stage-probability">{t("probability")}</Label>
        <Input
          id="stage-probability"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          value={probability}
          onChange={(e) => setProbability(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">{t("probabilityHint")}</p>
      </div>
      {needReason ? (
        <div className="space-y-1.5">
          <Label htmlFor="stage-lost-reason">{t("lostReason")}</Label>
          <Textarea
            id="stage-lost-reason"
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            maxLength={1000}
            rows={3}
            required
          />
        </div>
      ) : null}
      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

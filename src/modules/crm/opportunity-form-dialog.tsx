"use client";

/**
 * Prompt 35 — opportunity create/edit dialog (§58).
 *
 * Rules (§58):
 * - Stage picker shows the closed vocabulary; when the user picks WON the
 *   dialog requires a customer (§30) and when LOST it requires a lost
 *   reason (§32). For a NEW opportunity the stage stays on open stages
 *   (creation with WON/LOST is allowed server-side but the form keeps the
 *   create flow simple and honest: open stages only; terminal moves happen
 *   through Move Stage, §43).
 * - Expected value is labeled FORECAST (§12/§135) — never "revenue".
 * - DialogTitle + DialogDescription always render (§95).
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
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
import { FormDialog, MoneyInput, moneyToMinorOrNull } from "@/components/shared/table-kit";
import {
  OPEN_STAGES_EXPORT,
  useBusinessMembers,
  useOpportunityMutations,
} from "./crm-api";
import type { OpportunityDTO, OpportunityStage } from "@/lib/crm";
import { DEFAULT_STAGE_PROBABILITY } from "@/lib/crm/constants";
import { ApiClientError } from "@/lib/api-client";
import type { BusinessSummary } from "../shell/types";
import { fromMinor } from "@/lib/money";

type OppForm = {
  title: string;
  customerId: string;
  leadId: string;
  stage: OpportunityStage;
  expectedValue: string;
  probabilityPct: string;
  expectedCloseDate: string;
  assignedToUserId: string;
  description: string;
};

function formFrom(o: OpportunityDTO | null): OppForm {
  const precision = o ? 2 : 2;
  return o
    ? {
        title: o.title,
        customerId: o.customer?.id ?? "",
        leadId: o.lead?.id ?? "",
        stage: o.stage,
        expectedValue: String(fromMinor(o.expectedValueMinor, precision)),
        probabilityPct: String(o.probabilityPct),
        expectedCloseDate: o.expectedCloseDate ? o.expectedCloseDate.slice(0, 10) : "",
        assignedToUserId: o.assignedTo?.id ?? "",
        description: o.description ?? "",
      }
    : {
        title: "",
        customerId: "",
        leadId: "",
        stage: "DISCOVERY",
        expectedValue: "",
        probabilityPct: String(DEFAULT_STAGE_PROBABILITY.DISCOVERY),
        expectedCloseDate: "",
        assignedToUserId: "",
        description: "",
      };
}

export function OpportunityFormDialog({
  open,
  onOpenChange,
  editing,
  business,
  presetCustomerId,
  customers,
  leads,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: OpportunityDTO | null;
  business: BusinessSummary;
  /** Pre-selected customer (e.g. from a customer 360 CTA). */
  presetCustomerId?: string | null;
  /** Minimal same-business customer options (id/name only). */
  customers: { id: string; name: string }[];
  /** Minimal same-business lead options (id/name only). */
  leads?: { id: string; name: string }[];
}) {
  const t = useTranslations("crm.opportunity.form");
  const tStage = useTranslations("crm.opportunity.stage");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { create, update } = useOpportunityMutations();
  const { data: members } = useBusinessMembers();

  const [form, setForm] = useState<OppForm>(() => ({
    ...formFrom(editing),
    customerId: editing?.customer?.id ?? presetCustomerId ?? "",
  }));
  const [serverError, setServerError] = useState<string | null>(null);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setForm({
      ...formFrom(editing),
      customerId: editing?.customer?.id ?? presetCustomerId ?? "",
    });
    setServerError(null);
  }

  const valid = form.title.trim().length >= 2;
  const pending = create.isPending || update.isPending;
  const openStages = useMemo(() => OPEN_STAGES_EXPORT, []);

  const expectedValueMinor = moneyToMinorOrNull(form.expectedValue || "0", business.decimalPrecision);
  const probabilityValid =
    form.probabilityPct === "" ||
    (/^\d+$/.test(form.probabilityPct) &&
      Number(form.probabilityPct) >= 0 &&
      Number(form.probabilityPct) <= 100);

  function set<K extends keyof OppForm>(key: K, value: OppForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || pending || !probabilityValid || expectedValueMinor === null) return;
    setServerError(null);
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      customerId: form.customerId || null,
      leadId: form.leadId || null,
      stage: form.stage,
      probabilityPct: form.probabilityPct === "" ? undefined : Number(form.probabilityPct),
      expectedValueMinor: expectedValueMinor,
      expectedCloseDate: form.expectedCloseDate || null,
      assignedToUserId: form.assignedToUserId || null,
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, body });
      } else {
        await create.mutateAsync(body);
      }
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : tErrors("generic"));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("editTitle") : t("addTitle")}
      description={t("description")}
      submitLabel={editing ? tCommon("save") : tCommon("add")}
      cancelLabel={tCommon("cancel")}
      pending={pending}
      disabled={!valid || !probabilityValid || expectedValueMinor === null}
      onSubmit={submit}
    >
      <div className="space-y-1.5">
        <Label htmlFor="opp-title">{t("title")}</Label>
        <Input
          id="opp-title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={160}
          required
          autoFocus
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="opp-customer">{t("customer")}</Label>
          <Select
            value={form.customerId || "none"}
            onValueChange={(v) => set("customerId", v === "none" ? "" : v)}
          >
            <SelectTrigger id="opp-customer" aria-label={t("customer")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("noCustomer")}</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="opp-lead">{t("lead")}</Label>
          <Select value={form.leadId || "none"} onValueChange={(v) => set("leadId", v === "none" ? "" : v)}>
            <SelectTrigger id="opp-lead" aria-label={t("lead")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("noLead")}</SelectItem>
              {(leads ?? []).map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="opp-stage">{t("stage")}</Label>
          <Select
            value={form.stage}
            onValueChange={(v) => {
              const stage = v as OpportunityStage;
              set("stage", stage);
              set("probabilityPct", String(DEFAULT_STAGE_PROBABILITY[stage]));
            }}
          >
            <SelectTrigger id="opp-stage" aria-label={t("stage")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {openStages.map((s) => (
                <SelectItem key={s} value={s}>
                  {tStage(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <MoneyInput
            id="opp-value"
            label={t("expectedValue")}
            symbol={business.currencySymbol}
            value={form.expectedValue}
            onChange={(v) => set("expectedValue", v)}
            precision={business.decimalPrecision}
            invalidMsg={t("valueInvalid")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="opp-probability">{t("probability")}</Label>
          <Input
            id="opp-probability"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={form.probabilityPct}
            onChange={(e) => set("probabilityPct", e.target.value)}
            aria-invalid={!probabilityValid}
          />
          {!probabilityValid ? (
            <p className="text-destructive text-xs">{t("probabilityInvalid")}</p>
          ) : null}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="opp-close">{t("expectedClose")}</Label>
          <Input
            id="opp-close"
            type="date"
            value={form.expectedCloseDate}
            onChange={(e) => set("expectedCloseDate", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="opp-assignee">{t("assignedTo")}</Label>
          <Select
            value={form.assignedToUserId || "unassigned"}
            onValueChange={(v) => set("assignedToUserId", v === "unassigned" ? "" : v)}
          >
            <SelectTrigger id="opp-assignee" aria-label={t("assignedTo")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">{t("unassigned")}</SelectItem>
              {(members ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name ?? m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="opp-description">{t("descriptionField")}</Label>
        <Textarea
          id="opp-description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          maxLength={4000}
          rows={3}
        />
      </div>
      <p className="text-muted-foreground text-xs">{t("forecastNote")}</p>
      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

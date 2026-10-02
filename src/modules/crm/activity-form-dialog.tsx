"use client";

/**
 * Prompt 36 — activity create/edit dialog (§40/§77/§79).
 *
 * Law:
 * - DialogTitle + DialogDescription always render (§94).
 * - Context: when opened from an entity detail the context arrives via the
 *   `lockedContext` prop and renders READ-ONLY (§40/§77/§79) — never a
 *   switch to another entity. Only when NO locked context is provided (not
 *   used in Prompt 36 flows) a context selector appears (§78).
 * - The form NEVER changes the context on edit (§22 — server rejects it).
 * - occurredAt is picked as a BUSINESS-timezone wall clock and converted to
 *   a UTC instant (§16/§119) — the browser clock is never authoritative.
 * - Duration is integer minutes 1–1440 (§14/§122).
 */

import { useState } from "react";
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
import { FormDialog } from "@/components/shared/table-kit";
import { ACTIVITY_TYPES, CRM_CONTEXT_TYPES, type ActivityType, type CrmContextType } from "@/lib/crm/activity-types";
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { useActivityMutations, type CrmContextInput } from "./crm-api";
import { useCustomerOptions, useLeadOptions, useOpportunityOptions } from "./crm-context-options";
import { ApiClientError } from "@/lib/api-client";
import type { BusinessSummary } from "../shell/types";

export type ActivityDialogContext = CrmContextInput & { title: string };

type ActivityForm = {
  type: ActivityType;
  title: string;
  description: string;
  occurredAt: string; // datetime-local value (business wall clock)
  durationMinutes: string;
};

function localNowWallClock(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date())
      .replace(/,\s*/, "T");
  } catch {
    return new Date().toISOString().slice(0, 16);
  }
}

/** ISO (UTC) → business-tz wall clock for the edit form. */
function utcToWallClock(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(iso))
      .replace(/,\s*/, "T");
  } catch {
    return iso.slice(0, 16);
  }
}

export function ActivityFormDialog({
  open,
  onOpenChange,
  business,
  editing,
  lockedContext,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  business: BusinessSummary;
  editing: {
    id: string;
    type: ActivityType;
    title: string;
    description: string | null;
    occurredAt: string;
    durationMinutes: number | null;
    context: CrmContextInput;
  } | null;
  lockedContext: ActivityDialogContext | null;
  onSaved?: () => void;
}) {
  const t = useTranslations("crm.activities.form");
  const tType = useTranslations("crm.activities.type");
  const tCtx = useTranslations("crm.activities.contextType");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { create, update } = useActivityMutations();
  const customers = useCustomerOptions(!lockedContext);
  const leads = useLeadOptions(!lockedContext);
  const opportunities = useOpportunityOptions(!lockedContext);

  const [form, setForm] = useState<ActivityForm>(() => ({
    type: editing?.type ?? "NOTE",
    title: editing?.title ?? "",
    description: editing?.description ?? "",
    occurredAt: editing
      ? utcToWallClock(editing.occurredAt, business.timezone)
      : localNowWallClock(business.timezone),
    durationMinutes: editing?.durationMinutes ? String(editing.durationMinutes) : "",
  }));
  // Opened-from-queue context selection (context selector is REQUIRED here, §78).
  const [ctxType, setCtxType] = useState<CrmContextType | "">("");
  const [ctxId, setCtxId] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setForm({
      type: editing?.type ?? "NOTE",
      title: editing?.title ?? "",
      description: editing?.description ?? "",
      occurredAt: editing
        ? utcToWallClock(editing.occurredAt, business.timezone)
        : localNowWallClock(business.timezone),
      durationMinutes: editing?.durationMinutes ? String(editing.durationMinutes) : "",
    });
    setCtxType("");
    setCtxId("");
    setServerError(null);
  }

  const titleValid = form.title.trim().length >= 2 && form.title.trim().length <= 160;
  const durationRaw = form.durationMinutes.trim();
  const durationValid =
    durationRaw === "" || (/^\d+$/.test(durationRaw) && Number(durationRaw) >= 1 && Number(durationRaw) <= 1440);
  const context: CrmContextInput | null =
    lockedContext ?? (ctxType && ctxId ? { type: ctxType, id: ctxId } : null);
  const valid = titleValid && durationValid && Boolean(context);
  const pending = create.isPending || update.isPending;

  function set<K extends keyof ActivityForm>(key: K, value: ActivityForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || pending || !context) return;
    setServerError(null);
    const instant = zonedWallClockToUtc(form.occurredAt, business.timezone);
    if (!instant) {
      setServerError(t("occurredInvalid"));
      return;
    }
    try {
      if (editing) {
        // §22 — context is immutable on PATCH.
        await update.mutateAsync({
          id: editing.id,
          ctx: editing.context,
          body: {
            type: form.type,
            title: form.title.trim(),
            description: form.description.trim() || null,
            occurredAt: instant.toISOString(),
            durationMinutes: durationRaw === "" ? null : Number(durationRaw),
          },
        });
      } else {
        await create.mutateAsync({
          type: form.type,
          title: form.title.trim(),
          description: form.description.trim() || null,
          occurredAt: instant.toISOString(),
          durationMinutes: durationRaw === "" ? null : Number(durationRaw),
          ...(context.type === "CUSTOMER"
            ? { customerId: context.id }
            : context.type === "LEAD"
              ? { leadId: context.id }
              : { opportunityId: context.id }),
        });
      }
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : tErrors("generic"));
    }
  }

  const contextLabel = (type: CrmContextType, id: string): string => {
    if (type === "CUSTOMER") return customers.find((c) => c.id === id)?.name ?? id;
    if (type === "LEAD") return leads.find((l) => l.id === id)?.name ?? id;
    return opportunities.find((o) => o.id === id)?.name ?? id;
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("editTitle") : t("addTitle")}
      description={t("description")}
      submitLabel={editing ? tCommon("save") : tCommon("add")}
      cancelLabel={tCommon("cancel")}
      pending={pending}
      disabled={!valid}
      onSubmit={submit}
    >
      {lockedContext ? (
        <div className="space-y-1.5">
          <Label>{t("context")}</Label>
          {/* §77 — locked context renders read-only: no accidental re-anchoring. */}
          <div
            className="bg-muted text-muted-foreground flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm"
            aria-live="polite"
          >
            <span className="text-xs font-medium tracking-wide uppercase">{tCtx(lockedContext.type)}</span>
            <span className="truncate" dir="auto">
              {lockedContext.title}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="activity-ctx-type">{t("context")}</Label>
            <Select
              value={ctxType}
              onValueChange={(v) => {
                setCtxType(v as CrmContextType);
                setCtxId("");
              }}
            >
              <SelectTrigger id="activity-ctx-type" aria-label={t("context")}>
                <SelectValue placeholder={t("selectContextType")} />
              </SelectTrigger>
              <SelectContent>
                {CRM_CONTEXT_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {tCtx(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="activity-ctx-id">{tCtx(ctxType || "CUSTOMER")}</Label>
            <Select value={ctxId} onValueChange={setCtxId} disabled={!ctxType}>
              <SelectTrigger id="activity-ctx-id" aria-label={t("context")}>
                <SelectValue placeholder={t("selectContext")} />
              </SelectTrigger>
              <SelectContent>
                {(ctxType === "CUSTOMER"
                  ? customers
                  : ctxType === "LEAD"
                    ? leads
                    : opportunities
                ).map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="activity-type">{t("type")}</Label>
          <Select value={form.type} onValueChange={(v) => set("type", v as ActivityType)}>
            <SelectTrigger id="activity-type" aria-label={t("type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_TYPES.map((a) => (
                <SelectItem key={a} value={a}>
                  {tType(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="activity-occurred">{t("occurredAt")}</Label>
          <Input
            id="activity-occurred"
            type="datetime-local"
            value={form.occurredAt}
            onChange={(e) => set("occurredAt", e.target.value)}
            required
          />
          <p className="text-muted-foreground text-xs">{t("occurredTzHint")}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="activity-title">{t("title")}</Label>
        <Input
          id="activity-title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={160}
          required
          autoFocus
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <div className="space-y-1.5">
          <Label htmlFor="activity-duration">{t("duration")}</Label>
          <Input
            id="activity-duration"
            type="number"
            min={1}
            max={1440}
            step={1}
            value={form.durationMinutes}
            onChange={(e) => set("durationMinutes", e.target.value)}
            placeholder="30"
            dir="ltr"
          />
          {!durationValid ? (
            <p className="text-destructive text-xs">{t("durationInvalid")}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="activity-description">{t("descriptionField")}</Label>
          <Textarea
            id="activity-description"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={4000}
            rows={3}
          />
        </div>
      </div>

      {lockedContext ? null : ctxType && ctxId ? (
        <p className="text-muted-foreground text-xs" dir="auto">
          {contextLabel(ctxType, ctxId)}
        </p>
      ) : null}

      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

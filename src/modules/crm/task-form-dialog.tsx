"use client";

/**
 * Prompt 36 — task create/edit dialog (§41/§78/§80).
 *
 * Law:
 * - DialogTitle + DialogDescription always render (§94).
 * - Context preselected + locked when opened from an entity detail; when
 *   opened from the work queue the context selector is REQUIRED (§78).
 * - Status is NEVER settable here (§26 — dedicated /status endpoint owns
 *   the state machine).
 * - dueAt is a BUSINESS-timezone wall clock converted to a UTC instant
 *   (§16/§119); optional.
 * - Assignee list = active members of THIS business only (§57/§69).
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
import { CRM_CONTEXT_TYPES, type CrmContextType } from "@/lib/crm/activity-types";
import { TASK_PRIORITIES, type TaskPriority } from "@/lib/crm/task-types";
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { useBusinessMembers, useTaskMutations, type CrmContextInput } from "./crm-api";
import { useCustomerOptions, useLeadOptions, useOpportunityOptions } from "./crm-context-options";
import { ApiClientError } from "@/lib/api-client";
import type { BusinessSummary } from "../shell/types";

export type TaskDialogContext = CrmContextInput & { title: string };

type TaskForm = {
  title: string;
  description: string;
  priority: TaskPriority;
  dueAt: string;
  assignedToUserId: string;
};

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

export function TaskFormDialog({
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
    title: string;
    description: string | null;
    priority: TaskPriority;
    dueAt: string | null;
    assignedToUserId: string | null;
    context: CrmContextInput;
  } | null;
  lockedContext: TaskDialogContext | null;
  onSaved?: () => void;
}) {
  const t = useTranslations("crm.tasks.form");
  const tPriority = useTranslations("crm.tasks.priority");
  const tCtx = useTranslations("crm.activities.contextType");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { create, update } = useTaskMutations();
  const { data: members } = useBusinessMembers();
  const customers = useCustomerOptions(!lockedContext);
  const leads = useLeadOptions(!lockedContext);
  const opportunities = useOpportunityOptions(!lockedContext);

  const [form, setForm] = useState<TaskForm>(() => ({
    title: editing?.title ?? "",
    description: editing?.description ?? "",
    priority: editing?.priority ?? "NORMAL",
    dueAt: editing?.dueAt ? utcToWallClock(editing.dueAt, business.timezone) : "",
    assignedToUserId: editing?.assignedToUserId ?? "",
  }));
  const [ctxType, setCtxType] = useState<CrmContextType | "">("");
  const [ctxId, setCtxId] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setForm({
      title: editing?.title ?? "",
      description: editing?.description ?? "",
      priority: editing?.priority ?? "NORMAL",
      dueAt: editing?.dueAt ? utcToWallClock(editing.dueAt, business.timezone) : "",
      assignedToUserId: editing?.assignedToUserId ?? "",
    });
    setCtxType("");
    setCtxId("");
    setServerError(null);
  }

  const titleValid = form.title.trim().length >= 2 && form.title.trim().length <= 160;
  const context: CrmContextInput | null =
    lockedContext ?? (ctxType && ctxId ? { type: ctxType, id: ctxId } : null);
  const valid = titleValid && Boolean(context);
  const pending = create.isPending || update.isPending;

  function set<K extends keyof TaskForm>(key: K, value: TaskForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || pending || !context) return;
    setServerError(null);
    const dueInstant = form.dueAt ? zonedWallClockToUtc(form.dueAt, business.timezone) : null;
    if (form.dueAt && !dueInstant) {
      setServerError(t("dueInvalid"));
      return;
    }
    const base = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      dueAt: dueInstant ? dueInstant.toISOString() : null,
      assignedToUserId: form.assignedToUserId || null,
    };
    try {
      if (editing) {
        // §26 — status/context immutable on PATCH.
        await update.mutateAsync({ id: editing.id, ctx: editing.context, body: base });
      } else {
        await create.mutateAsync({
          ...base,
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
            <Label htmlFor="task-ctx-type">{t("context")}</Label>
            <Select
              value={ctxType}
              onValueChange={(v) => {
                setCtxType(v as CrmContextType);
                setCtxId("");
              }}
            >
              <SelectTrigger id="task-ctx-type" aria-label={t("context")}>
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
            <Label htmlFor="task-ctx-id">{tCtx(ctxType || "CUSTOMER")}</Label>
            <Select value={ctxId} onValueChange={setCtxId} disabled={!ctxType}>
              <SelectTrigger id="task-ctx-id" aria-label={t("context")}>
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

      <div className="space-y-1.5">
        <Label htmlFor="task-title">{t("title")}</Label>
        <Input
          id="task-title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={160}
          required
          autoFocus
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="task-priority">{t("priority")}</Label>
          <Select value={form.priority} onValueChange={(v) => set("priority", v as TaskPriority)}>
            <SelectTrigger id="task-priority" aria-label={t("priority")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {tPriority(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="task-due">{t("due")}</Label>
          <Input
            id="task-due"
            type="datetime-local"
            value={form.dueAt}
            onChange={(e) => set("dueAt", e.target.value)}
          />
          <p className="text-muted-foreground text-xs">{t("dueTzHint")}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task-assignee">{t("assignedTo")}</Label>
        <Select
          value={form.assignedToUserId || "unassigned"}
          onValueChange={(v) => set("assignedToUserId", v === "unassigned" ? "" : v)}
        >
          <SelectTrigger id="task-assignee" aria-label={t("assignedTo")}>
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

      <div className="space-y-1.5">
        <Label htmlFor="task-description">{t("descriptionField")}</Label>
        <Textarea
          id="task-description"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          maxLength={4000}
          rows={3}
        />
      </div>

      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

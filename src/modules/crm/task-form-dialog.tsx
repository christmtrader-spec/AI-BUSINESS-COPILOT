"use client";

/**
 * Prompt 36 — task create/edit dialog (§41/§78/§80).
 * Prompt 37 — reminder configuration section (§58/§59/§60/§106/§107/§108).
 *
 * Law:
 * - DialogTitle + DialogDescription always render (§94 — FormDialog).
 * - Context preselected + locked when opened from an entity detail; when
 *   opened from the work queue the context selector is REQUIRED (§78).
 * - Status is NEVER settable here (§26 — dedicated /status endpoint owns
 *   the state machine).
 * - dueAt is a BUSINESS-timezone wall clock converted to a UTC instant
 *   (§16/§119); optional.
 * - Assignee list = active members of THIS business only (§57/§69).
 * - Reminder controls (§58): enable due reminder + closed offset
 *   vocabulary + overdue alert. WITHOUT a due date every reminder control
 *   is DISABLED with an explanatory hint (§59). Clearing dueAt disables
 *   the reminder settings in the UI immediately; the SERVER re-validates
 *   and normalizes everything anyway (§59 — server remains authoritative).
 * - Edit loads the STORED reminder values — no stale local defaults (§60).
 * - Visual hierarchy (§108): core fields → due date → assignment →
 *   reminder settings; stacked layout on mobile (§107).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BellRing, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import {
  REMINDER_OFFSET_MINUTES,
  TASK_PRIORITIES,
  type ReminderOffsetMinutes,
  type TaskPriority,
} from "@/lib/crm/task-types";
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
  reminderEnabled: boolean;
  /** Stored value may be any integer from the DTO; submission re-validates. */
  reminderMinutesBefore: ReminderOffsetMinutes | number | "";
  overdueAlertEnabled: boolean;
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
    // Prompt 37 (§60) — stored reminder configuration (DTO shape).
    reminderEnabled: boolean;
    reminderMinutesBefore: ReminderOffsetMinutes | number | null;
    overdueAlertEnabled: boolean;
    context: CrmContextInput;
  } | null;
  lockedContext: TaskDialogContext | null;
  onSaved?: () => void;
}) {
  const t = useTranslations("crm.tasks.form");
  const tPriority = useTranslations("crm.tasks.priority");
  const tCtx = useTranslations("crm.activities.contextType");
  const tRem = useTranslations("crm.taskReminder");
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
    // §60 — load stored values when editing; safe defaults on create.
    reminderEnabled: editing?.reminderEnabled ?? false,
    reminderMinutesBefore: editing?.reminderMinutesBefore ?? "",
    overdueAlertEnabled: editing?.overdueAlertEnabled ?? false,
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
      reminderEnabled: editing?.reminderEnabled ?? false,
      reminderMinutesBefore: editing?.reminderMinutesBefore ?? "",
      overdueAlertEnabled: editing?.overdueAlertEnabled ?? false,
    });
    setCtxType("");
    setCtxId("");
    setServerError(null);
  }

  const titleValid = form.title.trim().length >= 2 && form.title.trim().length <= 160;
  const context: CrmContextInput | null =
    lockedContext ?? (ctxType && ctxId ? { type: ctxType, id: ctxId } : null);
  const hasDue = form.dueAt.trim().length > 0;
  // §59 — reminder controls are disabled without a due date.
  const reminderAvailable = hasDue;
  // §59 — an enabled reminder REQUIRES an offset; overdue alert requires dueAt.
  const reminderConsistent =
    !reminderAvailable || !form.reminderEnabled || form.reminderMinutesBefore !== "";
  const valid =
    titleValid &&
    Boolean(context) &&
    reminderConsistent &&
    (!form.reminderEnabled || reminderAvailable) &&
    (!form.overdueAlertEnabled || reminderAvailable);
  const pending = create.isPending || update.isPending;

  function set<K extends keyof TaskForm>(key: K, value: TaskForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /** §59 — clearing dueAt disables the reminder settings in the UI. */
  function setDueAt(value: string) {
    setForm((prev) => ({
      ...prev,
      dueAt: value,
      ...(value.trim() === ""
        ? { reminderEnabled: false, reminderMinutesBefore: "", overdueAlertEnabled: false }
        : {}),
    }));
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
      // §58/§91 — reminder fields ride the SAME create/patch body.
      reminderEnabled: reminderAvailable ? form.reminderEnabled : false,
      reminderMinutesBefore:
        reminderAvailable && form.reminderEnabled && form.reminderMinutesBefore !== ""
          ? form.reminderMinutesBefore
          : null,
      overdueAlertEnabled: reminderAvailable ? form.overdueAlertEnabled : false,
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
            onChange={(e) => setDueAt(e.target.value)}
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

      {/* Prompt 37 — Reminder settings (§58). Stacked on mobile (§107),
          visually last so the dialog hierarchy stays: core → due →
          assignee → reminders (§108). */}
      <div className="bg-muted/40 rounded-lg border p-3">
        <p className="text-muted-foreground flex items-center gap-1.5 pb-1 text-xs font-medium tracking-wide uppercase">
          <BellRing className="size-3.5" aria-hidden="true" />
          {tRem("reminders")}
        </p>

        {!reminderAvailable ? (
          <p className="text-muted-foreground text-xs">{tRem("setDueDateFirst")}</p>
        ) : null}

        <div className="flex flex-col gap-3 pt-1">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="task-reminder-enabled" className="text-sm font-normal">
              {tRem("enableReminder")}
            </Label>
            <Switch
              id="task-reminder-enabled"
              checked={reminderAvailable && form.reminderEnabled}
              disabled={!reminderAvailable}
              onCheckedChange={(checked) => {
                set("reminderEnabled", checked);
                if (!checked) set("reminderMinutesBefore", "");
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="task-reminder-offset" className="text-sm font-normal">
              {tRem("remindBefore")}
            </Label>
            <Select
              value={form.reminderMinutesBefore === "" ? "none" : String(form.reminderMinutesBefore)}
              disabled={!reminderAvailable || !form.reminderEnabled}
              onValueChange={(v) => {
                if (v === "none") set("reminderMinutesBefore", "");
                else set("reminderMinutesBefore", Number(v) as ReminderOffsetMinutes);
              }}
            >
              <SelectTrigger id="task-reminder-offset" className="w-40" aria-label={tRem("remindBefore")}>
                <SelectValue placeholder={tRem("remindBefore")} />
              </SelectTrigger>
              <SelectContent>
                {REMINDER_OFFSET_MINUTES.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {tRem(`offsets.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="task-overdue-alert" className="text-sm font-normal">
              <span className="flex items-center gap-1.5">
                <ShieldAlert className="size-3.5" aria-hidden="true" />
                {tRem("overdueAlert")}
              </span>
            </Label>
            <Switch
              id="task-overdue-alert"
              checked={reminderAvailable && form.overdueAlertEnabled}
              disabled={!reminderAvailable}
              onCheckedChange={(checked) => set("overdueAlertEnabled", checked)}
            />
          </div>
        </div>
      </div>

      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

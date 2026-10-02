"use client";

/**
 * Prompt 36 — task status dialog (§42/§81/§82/§121).
 *
 * Closed radio choices (Open / In progress / Completed / Canceled) with a
 * completion/cancel note that explains the semantics. The state machine is
 * server-validated — invalid transitions surface the server message. For
 * CANCELED an explicit inline warning appears (existing confirm pattern,
 * one dialog instead of a stacked second confirm).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { FormDialog } from "@/components/shared/table-kit";
import { TASK_STATUSES, type TaskStatus } from "@/lib/crm/task-types";
import { useTaskMutations, type CrmContextInput } from "./crm-api";
import { ApiClientError } from "@/lib/api-client";

export function TaskStatusDialog({
  open,
  onOpenChange,
  task,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: {
    id: string;
    status: TaskStatus;
    context: CrmContextInput;
  } | null;
  onSaved?: () => void;
}) {
  const t = useTranslations("crm.tasks.statusDialog");
  const tStatus = useTranslations("crm.tasks.status");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { changeStatus } = useTaskMutations();

  const [target, setTarget] = useState<TaskStatus>(task?.status ?? "OPEN");
  const [serverError, setServerError] = useState<string | null>(null);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setTarget(task?.status ?? "OPEN");
    setServerError(null);
  }

  const pending = changeStatus.isPending;
  const changed = task ? target !== task.status : false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!task || !changed || pending) return;
    setServerError(null);
    try {
      await changeStatus.mutateAsync({ id: task.id, status: target, ctx: task.context });
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
      disabled={!changed}
      onSubmit={submit}
    >
      <RadioGroup
        value={target}
        onValueChange={(v) => setTarget(v as TaskStatus)}
        aria-label={t("title")}
        className="gap-3"
      >
        {TASK_STATUSES.map((s) => (
          <div key={s} className="flex items-start gap-3">
            <RadioGroupItem value={s} id={`task-status-${s}`} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`task-status-${s}`} className="font-normal">
                {tStatus(s)}
              </Label>
              <span className="text-muted-foreground text-xs">{t(`hint.${s}`)}</span>
            </div>
          </div>
        ))}
      </RadioGroup>

      {target === "CANCELED" ? (
        <p className="text-destructive text-sm" role="alert">
          {t("cancelWarning")}
        </p>
      ) : null}
      {target === "COMPLETED" ? (
        <p className="text-muted-foreground text-sm">{t("completeNote")}</p>
      ) : null}

      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

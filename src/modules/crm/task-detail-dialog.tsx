"use client";

/**
 * Prompt 36 — task detail dialog (§45).
 *
 * Shows the full task (title/description/priority/status/due/assignee/
 * context/creator/timestamps/completedAt) with Edit · Change status ·
 * Delete actions. NO reminder action exists (§33/§66). Delete uses the
 * shared confirmation pattern. The dialog opens from the work queue and
 * entity pages via internal state (§53 — no new route).
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CalendarClock, CalendarDays, Flag, Pencil, RefreshCcw, StickyNote, Trash2, UserRound } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { TaskStatusBadge, PriorityBadge } from "./crm-badges";
import { TaskFormDialog } from "./task-form-dialog";
import { TaskStatusDialog } from "./task-status-dialog";
import { useTaskMutations, type CrmContextInput } from "./crm-api";
import { navigateToEntity } from "../entities/entity-route";
import type { TaskPriority, TaskStatus } from "@/lib/crm/task-types";
import type { BusinessSummary } from "../shell/types";
import { fmtDateTime } from "../finance-shared/finance-kit";

export type TaskDetailData = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  context: CrmContextInput & { title: string };
  assignedTo: { id: string; name: string | null } | null;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

function DetailRow({ icon: Icon, label, value }: { icon: typeof Flag; label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground flex items-center gap-1 text-xs font-medium tracking-wide uppercase">
        <Icon className="size-3" aria-hidden="true" />
        {label}
      </p>
      {value ? (
        <p className="text-sm break-words" dir="auto">
          {value}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">—</p>
      )}
    </div>
  );
}

export function TaskDetailDialog({
  open,
  onOpenChange,
  task,
  business,
  writable,
  onMutated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: TaskDetailData | null;
  business: BusinessSummary;
  writable: boolean;
  onMutated?: () => void;
}) {
  const t = useTranslations("crm.tasks.detail");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tCtx = useTranslations("crm.activities.contextType");
  const { remove } = useTaskMutations();
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () =>
      api(`/api/v1/crm/tasks/${encodeURIComponent(task!.id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      onMutated?.();
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  if (!task) return null;

  const contextEntity =
    task.context.type === "CUSTOMER" ? "customer" : task.context.type === "LEAD" ? "lead" : "opportunity";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-start" dir="auto">
              {task.title}
            </DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            {task.dueAt ? (
              <span className="text-muted-foreground flex items-center gap-1 text-xs" dir="ltr">
                <CalendarClock className="size-3.5" aria-hidden="true" />
                {fmtDateTime(business, task.dueAt)}
              </span>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <DetailRow icon={StickyNote} label={t("descriptionField")} value={task.description} />
            <DetailRow
              icon={CalendarDays}
              label={t("completedAt")}
              value={task.completedAt ? fmtDateTime(business, task.completedAt) : null}
            />
            <DetailRow
              icon={UserRound}
              label={t("assignee")}
              value={task.assignedTo?.name ?? null}
            />
            <DetailRow icon={UserRound} label={t("createdBy")} value={task.createdBy?.name ?? null} />
            <DetailRow icon={CalendarDays} label={t("createdAt")} value={fmtDateTime(business, task.createdAt)} />
            <DetailRow
              icon={Flag}
              label={t("context")}
              value={`${tCtx(task.context.type)}: ${task.context.title}`}
            />
          </div>

          {task.context.id ? (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                onOpenChange(false);
                navigateToEntity(contextEntity, task.context.id);
              }}
            >
              {t("openContext")}
            </Button>
          ) : null}

          <Separator />

          {writable ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="size-4" aria-hidden="true" />
                {tCommon("edit")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setStatusOpen(true)}>
                <RefreshCcw className="size-4" aria-hidden="true" />
                {t("changeStatus")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (window.confirm(t("deleteConfirm"))) deleteMutation.mutate();
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {tCommon("delete")}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <TaskFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        business={business}
        editing={
          task
            ? {
                id: task.id,
                title: task.title,
                description: task.description,
                priority: task.priority,
                dueAt: task.dueAt,
                assignedToUserId: task.assignedTo?.id ?? null,
                context: task.context,
              }
            : null
        }
        lockedContext={task?.context ?? null}
        onSaved={onMutated}
      />
      <TaskStatusDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        task={task ? { id: task.id, status: task.status, context: task.context } : null}
        onSaved={onMutated}
      />
    </>
  );
}

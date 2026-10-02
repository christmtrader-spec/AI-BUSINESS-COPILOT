"use client";

/**
 * Prompt 36 — CRM tasks / work-queue view (§43/§44/§46/§86/§118).
 *
 * SERVER-driven buckets (§118): overdue / today / upcoming / unscheduled
 * arrive classified from /api/v1/crm/tasks/work-queue — the client ONLY
 * renders. Section cards collapse cleanly when empty (§86); task cards
 * keep ≥44px interactive areas (§46); overdue is icon + text + badge,
 * never color-only (§46). Click a task → TaskDetailDialog (§45); click a
 * context chip → exact entity detail. "Create task" from here opens the
 * task form with a REQUIRED context selector (§78).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlarmClock,
  CalendarClock,
  CalendarClock as CalendarClockIcon,
  CheckCircle2,
  ListTodo,
  Plus,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/rbac";
import { can } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { api } from "@/lib/api-client";
import type { TaskDTO } from "@/lib/crm/task-dto";
import { useCrmWorkQueue, useTaskMutations } from "./crm-api";
import { OverdueBadge, PriorityBadge, TaskStatusBadge } from "./crm-badges";
import { TaskFormDialog } from "./task-form-dialog";
import { TaskDetailDialog, type TaskDetailData } from "./task-detail-dialog";
import { navigateToEntity } from "../entities/entity-route";
import type { WorkQueueTask, WorkQueueResponse } from "@/lib/crm/work-queue-types";
import type { TaskStatus } from "@/lib/crm/task-types";
import type { BusinessSummary } from "../shell/types";
import { fmtDateTime } from "../finance-shared/finance-kit";

type TaskDTOEnvelope = TaskDTO;

export function TasksView({ business, role }: { business: BusinessSummary; role: Role }) {
  const t = useTranslations("crm.tasks");
  const tCtx = useTranslations("crm.activities.contextType");
  const writable = can(role, "data:write");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const queue = useCrmWorkQueue();
  const { changeStatus } = useTaskMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDetailData | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const data = queue.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["crm", businessId, "workQueue"] });
    void queryClient.invalidateQueries({ queryKey: ["crm", businessId, "timeline"] });
    void queryClient.invalidateQueries({ queryKey: ["crm", businessId, "tasks"] });
  };

  async function toggleComplete(task: WorkQueueTask, next: TaskStatus) {
    if (!writable) return;
    try {
      await changeStatus.mutateAsync({
        id: task.id,
        status: next,
        ctx: { type: task.contextType, id: task.contextId },
      });
      toast({ title: t(next === "COMPLETED" ? "completedToast" : "reopenedToast") });
      refresh();
    } catch {
      toast({ title: t("statusError"), variant: "destructive" });
    }
  }

  function openDetail(task: WorkQueueTask) {
    setDetailTask({
      id: task.id,
      title: task.title,
      description: null,
      status: task.status as TaskStatus,
      priority: task.priority as TaskDetailData["priority"],
      dueAt: task.dueAt,
      completedAt: null,
      context: {
        type: task.contextType,
        id: task.contextId,
        title: task.contextTitle,
      },
      assignedTo: task.assignedTo ? { id: task.assignedTo.id, name: task.assignedTo.name } : null,
      createdBy: null,
      createdAt: task.dueAt ?? new Date().toISOString(),
      updatedAt: task.dueAt ?? new Date().toISOString(),
    });
    setDetailOpen(true);
    // Fetch the authoritative detail (queue rows are summary-shaped).
    void api<TaskDTOEnvelope>(`/api/v1/crm/tasks/${encodeURIComponent(task.id)}`)
      .then((d) => {
        setDetailTask({
          id: d.id,
          title: d.title,
          description: d.description,
          status: d.status,
          priority: d.priority,
          dueAt: d.dueAt,
          completedAt: d.completedAt,
          context: d.context,
          assignedTo: d.assignedTo ? { id: d.assignedTo.id, name: d.assignedTo.name } : null,
          createdBy: d.createdBy ? { id: d.createdBy.id, name: d.createdBy.name } : null,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        });
      })
      .catch(() => undefined);
  }

  const sections: {
    key: keyof Pick<WorkQueueResponse, "overdue" | "today" | "upcoming" | "unscheduled">;
    label: string;
    icon: typeof AlarmClock;
  }[] = [
    { key: "overdue", label: t("buckets.overdue"), icon: AlarmClock },
    { key: "today", label: t("buckets.today"), icon: CalendarClock },
    { key: "upcoming", label: t("buckets.upcoming"), icon: CalendarClockIcon },
    { key: "unscheduled", label: t("buckets.unscheduled"), icon: ListTodo },
  ];

  const total =
    (data?.overdue.length ?? 0) +
    (data?.today.length ?? 0) +
    (data?.upcoming.length ?? 0) +
    (data?.unscheduled.length ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {t("subtitle", { count: data?.counts.myOpenTaskCount ?? 0 })}
        </p>
        {writable ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            {t("createTask")}
          </Button>
        ) : null}
      </div>

      {queue.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : queue.isError ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-destructive text-sm" role="alert">
              {t("loadError")}
            </p>
          </CardContent>
        </Card>
      ) : total === 0 ? (
        /* §86 — sections collapse; one honest empty state + CTA. */
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <ListTodo className="text-muted-foreground size-8" aria-hidden="true" />
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
            {writable ? (
              <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                {t("createTask")}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sections.map((section) => {
            const items = data?.[section.key] ?? [];
            if (items.length === 0) return null; // §86 — collapse empty sections
            return (
              <Card key={section.key} className="flex flex-col">
                <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <section.icon
                      className={cn("size-4", section.key === "overdue" && "text-destructive")}
                      aria-hidden="true"
                    />
                    {section.label}
                  </CardTitle>
                  <span className="text-muted-foreground text-xs">
                    {t("sectionCount", { count: items.length })}
                  </span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {items.map((task) => (
                    <TaskQueueCard
                      key={task.id}
                      task={task}
                      business={business}
                      overdue={section.key === "overdue"}
                      writable={writable}
                      busy={changeStatus.isPending}
                      onToggleComplete={toggleComplete}
                      onOpen={openDetail}
                    />
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <TaskFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        business={business}
        editing={null}
        lockedContext={null}
        onSaved={refresh}
      />
      <TaskDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        task={detailTask}
        business={business}
        writable={writable}
        onMutated={refresh}
      />
    </div>
  );
}

function TaskQueueCard({
  task,
  business,
  overdue,
  writable,
  busy,
  onToggleComplete,
  onOpen,
}: {
  task: WorkQueueTask;
  business: BusinessSummary;
  overdue: boolean;
  writable: boolean;
  busy: boolean;
  onToggleComplete: (task: WorkQueueTask, next: TaskStatus) => void;
  onOpen: (task: WorkQueueTask) => void;
}) {
  const t = useTranslations("crm.tasks");
  const tCtx = useTranslations("crm.activities.contextType");
  const completed = task.status === "COMPLETED";

  return (
    <div
      className={cn(
        "hover:bg-muted/40 flex min-h-11 items-start gap-3 rounded-lg border p-3 transition-colors",
        overdue && "border-destructive/30",
      )}
    >
      {writable ? (
        <Checkbox
          aria-label={completed ? t("reopen") : t("complete")}
          className="mt-0.5 size-5"
          checked={completed}
          disabled={busy}
          onCheckedChange={(checked) =>
            void onToggleComplete(task, checked ? "COMPLETED" : "OPEN")
          }
        />
      ) : (
        <CheckCircle2
          className={cn("mt-0.5 size-5", completed ? "text-emerald-600" : "text-muted-foreground")}
          aria-hidden="true"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          onClick={() => onOpen(task)}
          className="text-start text-sm font-medium break-words underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {task.title}
        </button>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <PriorityBadge priority={task.priority as TaskDetailData["priority"]} />
          <TaskStatusBadge status={task.status as TaskStatus} />
          {overdue ? <OverdueBadge label={t("overdueBadge")} /> : null}
          {task.dueAt ? (
            <span className="text-muted-foreground flex items-center gap-1" dir="ltr">
              <CalendarClock className="size-3" aria-hidden="true" />
              {fmtDateTime(business, task.dueAt)}
            </span>
          ) : null}
          {task.assignedTo ? (
            <span className="text-muted-foreground truncate" dir="auto">
              {task.assignedTo.name ?? task.assignedTo.email}
            </span>
          ) : null}
          {task.contextId ? (
            <button
              type="button"
              onClick={() => {
                navigateToEntity(
                  task.contextType === "CUSTOMER"
                    ? "customer"
                    : task.contextType === "LEAD"
                      ? "lead"
                      : "opportunity",
                  task.contextId,
                );
              }}
              className="text-primary inline-flex items-center gap-1 rounded px-1 py-0.5 underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tCtx(task.contextType)}: <span dir="auto">{task.contextTitle}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}


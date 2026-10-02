"use client";

/**
 * Prompt 36 — CRM timeline card (§37/§38/§39/§47/§48/§83–§85).
 *
 * Unified activities + tasks feed for ONE context, server-merged and
 * bounded (§36/§127). Header hosts the "Add activity" / "Create task"
 * CTAs (writable roles only). Items: icon + type + title + description +
 * business-tz timestamp + actor/assignee + status/priority (§47/§48 —
 * semantic text, icon decorative, never color-only).
 *
 * Used by customer/lead/opportunity detail views; context is locked to the
 * page's entity (§37–§39).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, CalendarPlus, History, ListTodo, StickyNote, UserRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityTypeBadge, PriorityBadge, TaskStatusBadge } from "./crm-badges";
import { ActivityFormDialog, type ActivityDialogContext } from "./activity-form-dialog";
import { TaskFormDialog, type TaskDialogContext } from "./task-form-dialog";
import { useCrmTimeline } from "./crm-api";
import type { TimelineItem } from "@/lib/crm/timeline-types";
import type { CrmContextType } from "@/lib/crm/activity-types";
import type { BusinessSummary } from "../shell/types";
import { fmtDateTime } from "../finance-shared/finance-kit";

const KIND_ICON = {
  ACTIVITY: StickyNote,
  TASK: ListTodo,
} as const;

export function CrmTimelineCard({
  contextType,
  contextId,
  contextTitle,
  business,
  writable,
}: {
  contextType: CrmContextType;
  contextId: string;
  contextTitle: string;
  business: BusinessSummary;
  writable: boolean;
}) {
  const t = useTranslations("crm.timeline");
  const tCtx = useTranslations("crm.activities.contextType");
  const timeline = useCrmTimeline(contextId ? { type: contextType, id: contextId } : null, {
    pageSize: 25,
  });
  const [activityOpen, setActivityOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  const ctx: ActivityDialogContext & TaskDialogContext = {
    type: contextType,
    id: contextId,
    title: contextTitle,
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" aria-hidden="true" />
          {t("title")}
        </CardTitle>
        {writable ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setActivityOpen(true)}>
              <CalendarPlus className="size-4" aria-hidden="true" />
              {t("addActivity")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTaskOpen(true)}>
              <ListTodo className="size-4" aria-hidden="true" />
              {t("createTask")}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {timeline.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : timeline.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("loadError")}
          </p>
        ) : (timeline.data?.items.length ?? 0) === 0 ? (
          /* §83–§85 — honest empty state + CTAs, no fake examples. */
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
            {writable ? (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setActivityOpen(true)}>
                  <CalendarPlus className="size-4" aria-hidden="true" />
                  {t("addActivity")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setTaskOpen(true)}>
                  <ListTodo className="size-4" aria-hidden="true" />
                  {t("createTask")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <ol className="flex flex-col" aria-label={t("title")}>
            {timeline.data!.items.map((item, index) => (
              <TimelineRow
                key={`${item.kind}-${item.id}`}
                item={item}
                business={business}
                last={index === timeline.data!.items.length - 1}
              />
            ))}
          </ol>
        )}
      </CardContent>

      <ActivityFormDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        business={business}
        editing={null}
        lockedContext={ctx}
        onSaved={() => void timeline.refetch()}
      />
      <TaskFormDialog
        open={taskOpen}
        onOpenChange={setTaskOpen}
        business={business}
        editing={null}
        lockedContext={ctx}
        onSaved={() => void timeline.refetch()}
      />
    </Card>
  );
}

function TimelineRow({
  item,
  business,
  last,
}: {
  item: TimelineItem;
  business: BusinessSummary;
  last: boolean;
}) {
  const t = useTranslations("crm.timeline");
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="relative flex gap-3 pb-3 pe-1 ps-1">
      {!last ? (
        <span
          className="bg-border absolute top-8 bottom-0 start-[15px] w-px"
          aria-hidden="true"
        />
      ) : null}
      <span className="bg-muted text-muted-foreground z-10 flex size-8 shrink-0 items-center justify-center rounded-full border">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {item.kind === "ACTIVITY" ? (
            item.activityType ? (
              <ActivityTypeBadge type={item.activityType} />
            ) : null
          ) : (
            item.taskStatus ? <TaskStatusBadge status={item.taskStatus} /> : null
          )}
          <span className="text-sm font-medium break-words" dir="auto">
            {item.title}
          </span>
          <span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-1 text-xs" dir="ltr">
            <CalendarClock className="size-3" aria-hidden="true" />
            {fmtDateTime(business, item.timestamp)}
          </span>
        </div>
        {item.description ? (
          <p className="text-muted-foreground line-clamp-3 text-sm break-words" dir="auto">
            {item.description}
          </p>
        ) : null}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {item.kind === "TASK" ? (
            <>
              {item.priority ? <PriorityBadge priority={item.priority} /> : null}
              {item.dueAt ? (
                <span className="flex items-center gap-1" dir="ltr">
                  <CalendarClock className="size-3" aria-hidden="true" />
                  {t("due")}: {fmtDateTime(business, item.dueAt)}
                </span>
              ) : (
                <span>{t("noDueDate")}</span>
              )}
              {item.assignee ? (
                <span className="flex items-center gap-1" dir="auto">
                  <UserRound className="size-3" aria-hidden="true" />
                  {item.assignee.name ?? ""}
                </span>
              ) : null}
            </>
          ) : item.actor ? (
            <span className="flex items-center gap-1" dir="auto">
              <UserRound className="size-3" aria-hidden="true" />
              {item.actor.name ?? ""}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export type { CrmContextType };

/* ========================================================================== */
/* Prompt 36 — Active tasks card (§38/§50/§51) — bounded ≤10, quick actions   */
/* ========================================================================== */

import { Checkbox } from "@/components/ui/checkbox";
import { Plus, ListTodo as ListTodoIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { useAppStore } from "@/store/app-store";
import { useCrmTasks, useTaskMutations } from "./crm-api";
import { ACTIVE_TASK_STATUSES, type TaskStatus } from "@/lib/crm/task-types";

/**
 * Bounded active-task list for ONE context (server filtered to
 * OPEN/IN_PROGRESS, pageSize 10) with quick complete + "Create task".
 * Rendered under the timeline card on lead/opportunity detail pages
 * (§38/§50/§51). The customer page keeps only the timeline card (§49) —
 * its task creation flows through the timeline header.
 */
export function CrmActiveTasksCard({
  contextType,
  contextId,
  business,
  writable,
}: {
  contextType: CrmContextType;
  contextId: string;
  business: BusinessSummary;
  writable: boolean;
}) {
  const t = useTranslations("crm.tasks.contextCard");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const tasks = useCrmTasks({
    ctx: contextId ? { type: contextType, id: contextId } : null,
    pageSize: 10,
  });
  const { changeStatus } = useTaskMutations();
  const [taskOpen, setTaskOpen] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["crm", businessId, "workQueue"] });
    void queryClient.invalidateQueries({ queryKey: ["crm", businessId, "timeline"] });
    void queryClient.invalidateQueries({ queryKey: ["crm", businessId, "tasks"] });
    void tasks.refetch();
  };

  const rows = (tasks.data?.items ?? []).filter((task) =>
    (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status),
  );

  async function toggle(taskId: string, ctx: { type: CrmContextType; id: string }, next: TaskStatus) {
    try {
      await changeStatus.mutateAsync({ id: taskId, status: next, ctx });
      toast({ title: t(next === "COMPLETED" ? "completedToast" : "reopenedToast") });
      refresh();
    } catch {
      toast({ title: t("statusError"), variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodoIcon className="size-4" aria-hidden="true" />
          {t("title")}
        </CardTitle>
        {writable ? (
          <Button variant="outline" size="sm" onClick={() => setTaskOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            {t("createTask")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {tasks.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          rows.map((task) => (
            <div
              key={task.id}
              className="hover:bg-muted/40 flex min-h-11 items-start gap-3 rounded-lg border p-3"
            >
              {writable ? (
                <Checkbox
                  aria-label={t("complete")}
                  className="mt-0.5 size-5"
                  checked={false}
                  disabled={changeStatus.isPending}
                  onCheckedChange={() =>
                    void toggle(task.id, { type: contextType, id: contextId }, "COMPLETED")
                  }
                />
              ) : (
                <ListTodo className="text-muted-foreground mt-0.5 size-5" aria-hidden="true" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-sm font-medium break-words" dir="auto">
                  {task.title}
                </p>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <PriorityBadge priority={task.priority} />
                  <TaskStatusBadge status={task.status} />
                  {task.dueAt ? (
                    <span dir="ltr">{fmtDateTime(business, task.dueAt)}</span>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>

      <TaskFormDialog
        open={taskOpen}
        onOpenChange={setTaskOpen}
        business={business}
        editing={null}
        lockedContext={{ type: contextType, id: contextId, title: "" }}
        onSaved={refresh}
      />
    </Card>
  );
}

"use client";

/**
 * Prompt 35 — CRM status/stage badges (§59/§94/§95).
 *
 * Law:
 * - Raw enum tokens NEVER render — everything localizes through the crm
 *   namespaces (§59).
 * - Status is never communicated by COLOR alone (§95): every badge pairs
 *   a color with a distinct icon.
 * - Only semantic design tokens (existing Tailwind palette classes already
 *   used across the app) — no arbitrary hardcoded colors (§94).
 */

import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Flag,
  Handshake,
  Phone,
  Search,
  Sparkles,
  Trophy,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LeadStatus, OpportunityStage } from "@/lib/crm";

type Tone = {
  icon: LucideIcon;
  className: string;
};

const LEAD_STATUS_TONE: Record<LeadStatus, Tone> = {
  NEW: { icon: Sparkles, className: "border-violet-300/60 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  CONTACTED: { icon: Phone, className: "border-sky-300/60 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  QUALIFIED: { icon: Search, className: "border-teal-300/60 bg-teal-500/10 text-teal-700 dark:text-teal-300" },
  DISQUALIFIED: { icon: Ban, className: "border-zinc-300/60 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300" },
  CONVERTED: { icon: CheckCircle2, className: "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
};

const STAGE_TONE: Record<OpportunityStage, Tone> = {
  DISCOVERY: { icon: Search, className: "border-violet-300/60 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  QUALIFIED: { icon: Phone, className: "border-teal-300/60 bg-teal-500/10 text-teal-700 dark:text-teal-300" },
  PROPOSAL: { icon: Handshake, className: "border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  NEGOTIATION: { icon: Flag, className: "border-orange-300/60 bg-orange-500/10 text-orange-700 dark:text-orange-300" },
  WON: { icon: Trophy, className: "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  LOST: { icon: XCircle, className: "border-zinc-300/60 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300" },
};

/** Lead status badge — icon + text (never color-only, §95). */
export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const tLeadStatus = useTranslations("crm.lead.status");
  const tone = LEAD_STATUS_TONE[status] ?? LEAD_STATUS_TONE.NEW;
  const Icon = tone.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tone.className)}>
      <Icon className="size-3" aria-hidden="true" />
      {tLeadStatus(status)}
    </Badge>
  );
}

/** Opportunity stage badge — icon + text (never color-only, §95). */
export function StageBadge({ stage }: { stage: OpportunityStage }) {
  const tStage = useTranslations("crm.opportunity.stage");
  const tone = STAGE_TONE[stage] ?? STAGE_TONE.DISCOVERY;
  const Icon = tone.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tone.className)}>
      <Icon className="size-3" aria-hidden="true" />
      {tStage(stage)}
    </Badge>
  );
}

/** Pipeline column header chip — small, with the stage icon. */
export function StageColumnHeading({ stage }: { stage: OpportunityStage }) {
  const tStage = useTranslations("crm.opportunity.stage");
  const tone = STAGE_TONE[stage] ?? STAGE_TONE.DISCOVERY;
  const Icon = tone.icon;
  return (
    <span className="flex items-center gap-1.5 text-sm font-semibold">
      <Icon className={cn("size-4", tone.className.split(" ").find((c) => c.startsWith("text-")))} aria-hidden="true" />
      {tStage(stage)}
    </span>
  );
}

/** Closed stage order for the pipeline board (§54/§7). */
export const PIPELINE_STAGES = [
  "DISCOVERY",
  "QUALIFIED",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
] as const satisfies readonly OpportunityStage[];

/** Dashed placeholder for empty pipeline columns (non-interactive, §31). */
export function EmptyColumnHint({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
      <CircleDashed className="size-3.5" aria-hidden="true" />
      {label}
    </div>
  );
}

/* ========================================================================== */
/* Prompt 36 — Task status / priority + activity type badges (§90/§93/§94)    */
/* ========================================================================== */

import { Clock3, ListTodo, StickyNote, CalendarCheck, CircleOff, Mail, Users, PhoneCall, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import type { TaskStatus, TaskPriority } from "@/lib/crm/task-types";
import type { ActivityType as ActivityTypeVocab } from "@/lib/crm/activity-types";

const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  OPEN: { icon: CircleDashed, className: "border-sky-300/60 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  IN_PROGRESS: { icon: Clock3, className: "border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  COMPLETED: { icon: CheckCircle2, className: "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  CANCELED: { icon: CircleOff, className: "border-zinc-300/60 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300" },
};

/** Task status badge — icon + localized text (never color-only, §93). */
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const t = useTranslations("crm.tasks.status");
  const tone = TASK_STATUS_TONE[status] ?? TASK_STATUS_TONE.OPEN;
  const Icon = tone.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tone.className)}>
      <Icon className="size-3" aria-hidden="true" />
      {t(status)}
    </Badge>
  );
}

const PRIORITY_TONE: Record<TaskPriority, Tone> = {
  URGENT: { icon: ArrowUpRight, className: "border-red-300/60 bg-red-500/10 text-red-700 dark:text-red-300" },
  HIGH: { icon: ArrowUpRight, className: "border-orange-300/60 bg-orange-500/10 text-orange-700 dark:text-orange-300" },
  NORMAL: { icon: Minus, className: "border-sky-300/60 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  LOW: { icon: ArrowDownRight, className: "border-zinc-300/60 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300" },
};

/** Task priority badge — icon + localized text (never color-only, §93). */
export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const t = useTranslations("crm.tasks.priority");
  const tone = PRIORITY_TONE[priority] ?? PRIORITY_TONE.NORMAL;
  const Icon = tone.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tone.className)}>
      <Icon className="size-3" aria-hidden="true" />
      {t(priority)}
    </Badge>
  );
}

const ACTIVITY_TYPE_ICON: Record<ActivityTypeVocab, LucideIcon> = {
  NOTE: StickyNote,
  CALL: PhoneCall,
  EMAIL: Mail,
  MEETING: Users,
  OTHER: ListTodo,
};

/** Small icon + label for an activity type (decorative icon, labeled text). */
export function ActivityTypeBadge({ type }: { type: ActivityTypeVocab }) {
  const t = useTranslations("crm.activities.type");
  const Icon = ACTIVITY_TYPE_ICON[type] ?? ListTodo;
  return (
    <Badge variant="outline" className="gap-1 font-medium">
      <Icon className="size-3" aria-hidden="true" />
      {t(type)}
    </Badge>
  );
}

/** Overdue marker — icon + text, never color-only (§46). */
export function OverdueBadge({ label }: { label: string }) {
  return (
    <Badge variant="outline" className="gap-1 border-red-300/60 bg-red-500/10 font-medium text-red-700 dark:text-red-300">
      <CalendarCheck className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

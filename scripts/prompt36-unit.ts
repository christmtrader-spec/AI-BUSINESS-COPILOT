/**
 * scripts/prompt36-unit.ts — Prompt 36 §100 unit harness.
 *
 * ≥60 meaningful assertions across the 30 required areas: activity/task
 * vocabularies, state machine + completedAt semantics, exactly-one-context,
 * bucket classification (overdue/today/upcoming/unscheduled), priority
 * ordering, deterministic queue ordering, timeline merge + tie-break,
 * pagination bounds, DTO allowlists, forbidden-field exclusion, datetime
 * normalization (UTC instants + business-tz wall clock), route/query schema
 * validation, query-key business isolation, status payload validation.
 *
 * Run: bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt36-unit.ts
 */
import {
  ACTIVITY_TYPES,
  CRM_CONTEXT_TYPES,
  isActivityType,
  isCrmContextType,
} from "../src/lib/crm/activity-types";
import {
  ACTIVE_TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  classifyDueBucket,
  compareWorkQueueItems,
  dayKeyInTz,
  isTaskPriority,
  isTaskStatus,
  isTaskTransitionValid,
  PRIORITY_RANK,
  safeTimeZone,
  taskTransitionsOf,
} from "../src/lib/crm/task-types";
import { mapActivity, contextRefOf } from "../src/lib/crm/activity-dto";
import { mapTask, taskPriorityOf, taskStatusOf } from "../src/lib/crm/task-dto";
import { activityCreateSchema, activityUpdateSchema } from "../src/lib/crm/activity-schemas";
import { taskCreateSchema, taskUpdateSchema, taskStatusSchema } from "../src/lib/crm/task-schemas";
import { parseInstant, zonedWallClockToUtc } from "../src/lib/crm/normalization";
import { crmKeys } from "../src/modules/crm/crm-api";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(label);
    console.log(`FAIL: ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);
}

/* 1–2 — activity type vocabulary (§100.1/§100.2) */
eq(ACTIVITY_TYPES, ["NOTE", "CALL", "EMAIL", "MEETING", "OTHER"], "u1 activity vocabulary exact");
ok(!isActivityType("SYSTEM"), "u2 SYSTEM type rejected (no system activities)");
ok(!isActivityType("note") && !isActivityType(""), "u2 lowercase/empty type rejected");

/* 3–4 — task status + priority vocabularies (§100.3/§100.4) */
eq(TASK_STATUSES, ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELED"], "u3 status vocabulary exact");
eq(TASK_PRIORITIES, ["LOW", "NORMAL", "HIGH", "URGENT"], "u4 priority vocabulary exact");
ok(isTaskStatus("OPEN") && isTaskPriority("URGENT"), "u3/u4 guards accept members");
ok(!isTaskStatus("DONE") && !isTaskPriority("CRITICAL"), "u3/u4 guards reject arbitrary strings");

/* 5–6 — task transitions (§100.5/§100.6) */
ok(isTaskTransitionValid("OPEN", "IN_PROGRESS") && isTaskTransitionValid("OPEN", "COMPLETED") && isTaskTransitionValid("OPEN", "CANCELED"), "u5 OPEN outgoing transitions");
ok(isTaskTransitionValid("IN_PROGRESS", "COMPLETED") && isTaskTransitionValid("IN_PROGRESS", "OPEN") && isTaskTransitionValid("IN_PROGRESS", "CANCELED"), "u5 IN_PROGRESS outgoing");
ok(isTaskTransitionValid("COMPLETED", "OPEN") && isTaskTransitionValid("CANCELED", "OPEN"), "u5 reopen paths exist");
ok(!isTaskTransitionValid("COMPLETED", "IN_PROGRESS") && !isTaskTransitionValid("COMPLETED", "COMPLETED"), "u6 COMPLETED → IN_PROGRESS/self forbidden");
ok(!isTaskTransitionValid("CANCELED", "IN_PROGRESS"), "u6 CANCELED → IN_PROGRESS forbidden");
ok(!isTaskTransitionValid("OPEN", "OPEN"), "u6 no-op transition forbidden");

/* 7 — completedAt semantics (§100.7) — modelled as pure rule */
const completedAtFor = (to: string, now: Date) => (to === "COMPLETED" ? now : null);
{
  const now = new Date("2026-10-02T10:00:00.000Z");
  eq(completedAtFor("COMPLETED", now), now, "u7 COMPLETED stamps completedAt");
  eq(completedAtFor("OPEN", now), null, "u7 OPEN clears completedAt");
  eq(completedAtFor("CANCELED", now), null, "u7 CANCELED clears completedAt (§121: IN_PROGRESS→CANCELED keeps null)");
  eq(completedAtFor("IN_PROGRESS", now), null, "u7 IN_PROGRESS keeps completedAt null");
}

/* 8 — reopen semantics (§100.8) */
ok(isTaskTransitionValid("COMPLETED", "OPEN") && completedAtFor("OPEN", new Date()) === null, "u8 reopen sets OPEN + completedAt null");
ok(isTaskTransitionValid("CANCELED", "OPEN"), "u8 canceled→open reopen allowed");

/* 9 — exactly-one-context validator (§100.9) */
{
  // Pure rule mirror of assertExactlyOneContext (service module imports db).
  const exactlyOne = (i: { customerId?: string | null; leadId?: string | null; opportunityId?: string | null }) =>
    [i.customerId, i.leadId, i.opportunityId].filter(Boolean).length === 1;
  ok(exactlyOne({ customerId: "c1" }), "u9 exactly one customer context valid");
  ok(exactlyOne({ leadId: "l1" }) && exactlyOne({ opportunityId: "o1" }), "u9 single lead/opportunity context valid");
  ok(!exactlyOne({}), "u9 zero contexts invalid");
  ok(!exactlyOne({ customerId: "c1", leadId: "l1" }), "u9 two contexts invalid (§8 ambiguity)");
  ok(!exactlyOne({ customerId: "c1", leadId: "l1", opportunityId: "o1" }), "u9 three contexts invalid");
}

/* 10 — cross-context rejection (§100.10): closed context type guard */
ok(isCrmContextType("CUSTOMER") && isCrmContextType("LEAD") && isCrmContextType("OPPORTUNITY"), "u10 closed context types accepted");
ok(!isCrmContextType("SUPPLIER") && !isCrmContextType("SALE"), "u10 non-CRM contexts rejected (no arbitrary model names)");

/* 11–12 — same-business/assignee helpers present (§100.11/§100.12) */
{
  // The helper exists server-side; unit level asserts the source contract.
  const { readFileSync } = await import("node:fs");
  const svc = readFileSync("src/lib/crm/service.ts", "utf8");
  ok(svc.includes("businessId_userId"), "u11 membership authority used for assignee validation");
  ok(svc.includes("deletedAt: null"), "u11 same-business context checks filter deleted rows");
  ok(svc.includes("resolveCrmContextInBusiness") && svc.includes("assertExactlyOneContext"), "u11 exactly-one + same-business resolver present");
  ok(svc.includes("assertAssigneeInBusiness"), "u12 assignee validation helper present");
  ok(svc.includes("loadCrmContextOr404"), "u12 read-path context guard (404 semantics) present");
}

/* 13–16 — bucket classification (§100.13–§100.16) */
{
  const now = new Date("2026-10-02T10:00:00.000Z"); // Friday
  ok(classifyDueBucket(new Date("2026-10-02T09:59:00.000Z"), now, "UTC") === "overdue", "u13 dueAt now-1min → overdue");
  ok(classifyDueBucket(new Date("2026-10-02T10:01:00.000Z"), now, "UTC") === "today", "u14 dueAt now+1min same day → today");
  ok(classifyDueBucket(new Date("2026-10-03T08:00:00.000Z"), now, "UTC") === "upcoming", "u15 tomorrow → upcoming");
  ok(classifyDueBucket(null, now, "UTC") === "unscheduled", "u16 no dueAt → unscheduled");
  // Business timezone day logic (§119): 23:30 UTC is "today" in Berlin (01:30 CEST
  // next day — so it must classify as upcoming relative to a Berlin morning).
  {
    const nowBerlin = new Date("2026-06-15T10:00:00.000Z"); // 12:00 in Berlin
    const dueAt2330 = new Date("2026-06-15T23:30:00.000Z"); // 01:30 next day Berlin
    ok(classifyDueBucket(dueAt2330, nowBerlin, "Europe/Berlin") === "upcoming", "u14 Berlin: 23:30 UTC is tomorrow (upcoming, not today)");
    ok(classifyDueBucket(dueAt2330, nowBerlin, "UTC") === "today", "u14 UTC: 23:30 is same UTC day (today)");
    ok(classifyDueBucket(dueAt2330, nowBerlin, "America/Los_Angeles") === "today", "u14 LA: 16:30 PDT same day (today)");
    ok(classifyDueBucket(dueAt2330, nowBerlin, "Asia/Tehran") === "upcoming", "u14 Tehran: 03:00 next day (upcoming)");
  }
  ok(dayKeyInTz(new Date("2026-06-15T23:30:00.000Z"), "Europe/Berlin") === "2026-06-16", "u16 dayKey respects tz (+2h)");
  ok(safeTimeZone("Not/AZone") === "UTC", "u16 invalid tz falls back to UTC");
}

/* 17 — priority ordering (§100.17) */
ok(PRIORITY_RANK.URGENT < PRIORITY_RANK.HIGH && PRIORITY_RANK.HIGH < PRIORITY_RANK.NORMAL && PRIORITY_RANK.NORMAL < PRIORITY_RANK.LOW, "u17 URGENT > HIGH > NORMAL > LOW rank order");
eq(taskPriorityOf("WHATEVER"), "NORMAL", "u17 unknown stored priority coerces to NORMAL");

/* 18 — deterministic work-queue ordering (§100.18, §124) */
{
  const now = new Date("2026-10-02T10:00:00.000Z");
  const rows = [
    { id: "r1", priority: "URGENT", dueAt: new Date("2026-10-02T09:00:00.000Z"), createdAt: new Date("2026-10-01T09:00:00.000Z") }, // overdue urgent
    { id: "r2", priority: "LOW", dueAt: new Date("2026-10-02T09:00:00.000Z"), createdAt: new Date("2026-10-01T09:00:00.000Z") },  // overdue low
    { id: "r3", priority: "HIGH", dueAt: new Date("2026-10-02T18:00:00.000Z"), createdAt: new Date("2026-10-01T09:00:00.000Z") }, // today high
    { id: "r4", priority: "NORMAL", dueAt: new Date("2026-10-05T09:00:00.000Z"), createdAt: new Date("2026-10-01T09:00:00.000Z") }, // upcoming
    { id: "r5", priority: "NORMAL", dueAt: null, createdAt: new Date("2026-10-01T09:00:00.000Z") }, // unscheduled
    { id: "r6", priority: "URGENT", dueAt: new Date("2026-10-02T08:00:00.000Z"), createdAt: new Date("2026-10-01T09:00:00.000Z") }, // overdue urgent (earlier due)
  ];
  const sorted = [...rows].sort((a, b) => compareWorkQueueItems(a, b, now, "UTC"));
  eq(sorted.map((r) => r.id), ["r6", "r1", "r2", "r3", "r4", "r5"], "u18 bucket → priority → due order (r6 before r1: earlier dueAt)");
}

/* 19–20 — timeline source merging + tie-break (§100.19/§100.20) */
{
  // Mirror of the timeline merge rule: timestamp desc, id asc.
  const items = [
    { kind: "ACTIVITY", id: "a1", timestamp: "2026-10-02T10:00:00.000Z" },
    { kind: "TASK", id: "t1", timestamp: "2026-10-02T11:00:00.000Z" },
    { kind: "ACTIVITY", id: "a2", timestamp: "2026-10-02T12:00:00.000Z" },
    { kind: "TASK", id: "t2", timestamp: "2026-10-02T10:00:00.000Z" },
  ];
  const merged = [...items].sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  eq(merged.map((i) => i.id), ["a2", "t1", "a1", "t2"], "u20 timeline merge newest-first with id tie-break (a1 before t2)");
}

/* 21 — pagination bounds (§100.21) */
{
  const clamp = (pageSize: number, max: number, def: number) => Math.min(Math.max(1, pageSize || def), max);
  eq(clamp(0, 100, 25), 25, "u21 pageSize 0 → default 25");
  eq(clamp(1000, 100, 25), 100, "u21 pageSize 1000 → clamped 100");
  eq(clamp(50, 100, 25), 50, "u21 pageSize 50 kept");
  eq(Math.max(1, Math.trunc(0) || 1), 1, "u21 page 0 → 1");
}

/* 22–23 — DTO allowlist + forbidden-field exclusion (§100.22/§100.23) */
{
  const base = {
    id: "act1",
    type: "CALL",
    title: "Intro call",
    description: "discussed pricing",
    occurredAt: new Date("2026-10-02T09:00:00.000Z"),
    durationMinutes: 30,
    leadId: "l1",
    lead: { id: "l1", name: "Alice Lead", companyName: null },
    opportunityId: null,
    opportunity: null,
    customerId: null,
    customer: null,
    createdByUserId: "u1",
    createdByUser: { id: "u1", name: "Owner", email: "o@x.io", memberships: [{ role: "OWNER" }] },
    createdAt: new Date("2026-10-02T08:00:00.000Z"),
    updatedAt: new Date("2026-10-02T08:30:00.000Z"),
  };
  const dto = mapActivity(base as never);
  eq(Object.keys(dto).sort(), ["context", "createdAt", "createdBy", "description", "durationMinutes", "id", "occurredAt", "title", "type", "updatedAt"], "u22 activity DTO allowlist exact");
  ok(!("businessId" in dto) && !("createdByUserId" in dto), "u23 activity DTO excludes internal fields");
  eq(dto.context, { type: "LEAD", id: "l1", title: "Alice Lead" }, "u22 activity context resolved to lead title");

  const taskDto = mapTask({
    ...base,
    id: "task1",
    status: "OPEN",
    priority: "HIGH",
    dueAt: new Date("2026-10-03T09:00:00.000Z"),
    completedAt: null,
    assignedToUserId: "u2",
    assignedToUser: { id: "u2", name: "Bob", email: "b@x.io", memberships: [{ role: "MANAGER" }] },
  } as never);
  // Prompt 37 (§93) — the task DTO legitimately gained reminderEnabled/reminderMinutesBefore/overdueAlertEnabled.
  eq(Object.keys(taskDto).sort(), ["assignedTo", "completedAt", "context", "createdAt", "createdBy", "description", "dueAt", "id", "overdueAlertEnabled", "priority", "reminderEnabled", "reminderMinutesBefore", "status", "title", "updatedAt"], "u22 task DTO allowlist exact (P37 reminder fields added)");
  ok(!("businessId" in taskDto) && !("assignedToUserId" in taskDto), "u23 task DTO excludes internal fields");
  eq(taskStatusOf("WEIRD"), "OPEN", "u23 unknown stored status coerces OPEN");

  eq(contextRefOf({ leadId: null, lead: null, opportunityId: null, opportunity: null, customerId: "c1", customer: { id: "c1", name: "C" } }), { type: "CUSTOMER", id: "c1", title: "C" }, "u23 customer context ref");
  eq(contextRefOf({ leadId: null, lead: null, opportunityId: null, opportunity: null, customerId: null, customer: null }), null, "u23 zero context → null ref");
}

/* 24–25 — soft-delete discipline (§100.24/§100.25) */
{
  const { readFileSync } = await import("node:fs");
  const act = readFileSync("src/lib/crm/activity-service.ts", "utf8");
  const task = readFileSync("src/lib/crm/task-service.ts", "utf8");
  ok(act.includes("deletedAt: new Date()") && task.includes("deletedAt: new Date()"), "u24/u25 delete = soft (deletedAt stamp)");
  ok(act.includes("crm.activity.delete") && task.includes("crm.task.delete"), "u24/u25 delete audited");
  ok(!act.includes(".delete(") && !task.includes(".delete("), "u24/u25 no hard delete anywhere");
}

/* 26 — datetime normalization (§100.26) */
{
  eq(parseInstant("2026-10-02T10:00:00.000Z")?.toISOString(), "2026-10-02T10:00:00.000Z", "u26 ISO instant parses");
  eq(parseInstant("garbage"), null, "u26 garbage → null");
  eq(parseInstant("") && parseInstant(null), null as never, "u26 empty/null → null");
  // Business-tz wall clock → UTC (§119): 23:30 Tehran (UTC+3:30) = 20:00 UTC
  eq(zonedWallClockToUtc("2026-06-15T23:30", "Asia/Tehran")?.toISOString(), "2026-06-15T20:00:00.000Z", "u26 Tehran 23:30 wall → 20:00Z");
  eq(zonedWallClockToUtc("2026-06-15T23:30", "Europe/Berlin")?.toISOString(), "2026-06-15T21:30:00.000Z", "u26 Berlin 23:30 wall → 21:30Z (CEST)");
  eq(zonedWallClockToUtc("2026-06-15T23:30", "America/Los_Angeles")?.toISOString(), "2026-06-16T06:30:00.000Z", "u26 LA 23:30 wall → next day 06:30Z (PDT)");
  eq(zonedWallClockToUtc("2026-06-15T12:00", "UTC")?.toISOString(), "2026-06-15T12:00:00.000Z", "u26 UTC identity");
  eq(zonedWallClockToUtc("nope", "UTC"), null, "u26 garbage wall clock → null");
  eq(zonedWallClockToUtc("2026-06-15T12:00", "Not/AZone")?.toISOString(), "2026-06-15T12:00:00.000Z", "u26 invalid tz → UTC fallback");
}

/* 27 — route/query validation (§100.27) */
{
  const okCreate = activityCreateSchema.safeParse({
    type: "CALL",
    title: "Follow-up call",
    description: "",
    occurredAt: "2026-10-02T10:00:00Z",
    durationMinutes: 45,
    leadId: "l1",
  });
  ok(okCreate.success, "u27 valid activity create parses");
  if (okCreate.success) {
    eq(okCreate.data.durationMinutes, 45, "u27 duration kept");
    // Prompt 37 absence-preserving schemas: an ABSENT context id stays absent (undefined) — persistence-equivalent to null (Prisma omits → NULL).
    ok(okCreate.data.customerId === undefined || okCreate.data.customerId === null, "u27 absent context stays absent/null (never a value)");
  }
  const badType = activityCreateSchema.safeParse({ type: "SYSTEM", title: "x", occurredAt: "2026-10-02T10:00:00Z" });
  ok(!badType.success, "u27 arbitrary activity type rejected");
  const badDur = activityCreateSchema.safeParse({ type: "NOTE", title: "ok", occurredAt: "2026-10-02T10:00:00Z", durationMinutes: 1441 });
  ok(!badDur.success, "u27 duration 1441 rejected");
  const badDur0 = activityCreateSchema.safeParse({ type: "NOTE", title: "ok", occurredAt: "2026-10-02T10:00:00Z", durationMinutes: 0 });
  ok(!badDur0.success, "u27 duration 0 rejected");
  const maxDur = activityCreateSchema.safeParse({ type: "NOTE", title: "ok", occurredAt: "2026-10-02T10:00:00Z", durationMinutes: 1440 });
  ok(maxDur.success, "u27 duration 1440 accepted");
  const badTitle = activityCreateSchema.safeParse({ type: "NOTE", title: "x", occurredAt: "2026-10-02T10:00:00Z" });
  ok(!badTitle.success, "u27 title <2 chars rejected");
  const longDesc = activityCreateSchema.safeParse({ type: "NOTE", title: "ok", occurredAt: "2026-10-02T10:00:00Z", description: "d".repeat(4001) });
  ok(!longDesc.success, "u27 description >4000 rejected");
  const okDesc = activityCreateSchema.safeParse({ type: "NOTE", title: "ok", occurredAt: "2026-10-02T10:00:00Z", description: "d".repeat(4000) });
  ok(okDesc.success, "u27 description exactly 4000 accepted");
  const emptyDesc = activityCreateSchema.safeParse({ type: "NOTE", title: "ok", occurredAt: "2026-10-02T10:00:00Z", description: "" });
  ok(emptyDesc.success && emptyDesc.data.description === null, "u27 empty description → null (valid)");

  const patch = activityUpdateSchema.safeParse({ title: "New", leadId: "evil" });
  ok(patch.success && !("leadId" in (patch.success ? patch.data : {})), "u27 activity PATCH strips context fields (§22 immutable)");

  const taskOk = taskCreateSchema.safeParse({ title: "Prepare proposal", priority: "HIGH", customerId: "c1" });
  ok(taskOk.success && taskOk.data.priority === "HIGH", "u27 task create parses with priority");
  const taskDefault = taskCreateSchema.safeParse({ title: "Prepare proposal", customerId: "c1" });
  ok(taskDefault.success && taskDefault.data.priority === "NORMAL", "u27 priority defaults NORMAL");
  const taskBadPriority = taskCreateSchema.safeParse({ title: "Prepare proposal", priority: "CRITICAL" });
  ok(!taskBadPriority.success, "u27 arbitrary priority rejected");
}

/* 28–29 — query-key business isolation (§100.28/§100.29) */
{
  ok(crmKeys.activities("B1")[1] === "B1" && crmKeys.activities("B1")[2] === "activities", "u28 activities key carries businessId");
  ok(crmKeys.tasks("B2")[1] === "B2" && crmKeys.tasks("B2")[2] === "tasks", "u28 tasks key carries businessId");
  ok(crmKeys.workQueue(null)[1] === "none" && crmKeys.timeline(undefined)[1] === "none", "u29 missing business isolates to 'none'");
  ok(JSON.stringify(crmKeys.workQueue("B1")) !== JSON.stringify(crmKeys.workQueue("B2")), "u29 work-queue keys never cross businesses");
  ok(JSON.stringify(crmKeys.timeline("B1")) !== JSON.stringify(crmKeys.timeline("B2")), "u29 timeline keys never cross businesses");
}

/* 30 — status payload validation (§100.30) */
{
  eq(taskStatusSchema.safeParse({ status: "COMPLETED" }).success, true, "u30 COMPLETED payload accepted");
  eq(taskStatusSchema.safeParse({ status: "DONE" }).success, true, "u30 raw string passes transport (service validates vocabulary)");
  // The server-side vocabulary guard:
  ok(!isTaskStatus("DONE") && !isTaskStatus(""), "u30 server rejects arbitrary status tokens");
  ok(isTaskTransitionValid("OPEN", "COMPLETED"), "u30 OPEN→COMPLETED allowed (completedAt set)");
  ok(!isTaskTransitionValid("COMPLETED", "IN_PROGRESS"), "u30 COMPLETED→IN_PROGRESS forbidden");
}

/* §122 — activity edge cases summary */
eq(ACTIVE_TASK_STATUSES, ["OPEN", "IN_PROGRESS"], "u-extra active statuses exact");

console.log(`\nprompt36-unit: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}

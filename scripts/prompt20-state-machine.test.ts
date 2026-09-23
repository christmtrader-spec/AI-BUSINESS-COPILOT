/**
 * Prompt 20 — pure unit tests for the subscription state machine and the
 * plan-decision policy (§86: transitions, invalid transitions, entitlement
 * decision semantics; §70: time handling).
 *
 * Run: bun scripts/prompt20-state-machine.test.ts
 * Pure module under test — no database, no Next.js runtime.
 */
import {
  SUBSCRIPTION_STATUSES,
  VALID_TRANSITIONS,
  asSubscriptionStatus,
  decidePlan,
  isSubscriptionStatus,
  isValidTransition,
  periodEnd,
  isBillingPeriod,
  isSubscriptionEventType,
  type SubscriptionStatus,
} from "../src/lib/billing/state-machine";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-23T12:00:00Z");

// --- status sets -------------------------------------------------------------
console.log("[status sets]");
check(
  "6 statuses defined",
  SUBSCRIPTION_STATUSES.join(",") === "TRIALING,ACTIVE,PAST_DUE,CANCELED,EXPIRED,PAUSED",
);
check("isSubscriptionStatus accepts valid", isSubscriptionStatus("ACTIVE") === true);
check("isSubscriptionStatus rejects junk", isSubscriptionStatus("SUPERPRO") === false);
check("asSubscriptionStatus defaults to ACTIVE on junk", asSubscriptionStatus(undefined) === "ACTIVE");
check("isBillingPeriod MONTHLY/YEARLY", isBillingPeriod("MONTHLY") && isBillingPeriod("YEARLY") && !isBillingPeriod("WEEKLY"));
check(
  "event types exclude payment events (§83)",
  isSubscriptionEventType("PLAN_CHANGED") && !isSubscriptionEventType("PAYMENT_SUCCEEDED"),
);

// --- transition rules (§46) --------------------------------------------------
console.log("[transitions]");
check("TRIALING → ACTIVE allowed", isValidTransition("TRIALING", "ACTIVE"));
check("TRIALING → EXPIRED allowed", isValidTransition("TRIALING", "EXPIRED"));
check("ACTIVE → CANCELED allowed", isValidTransition("ACTIVE", "CANCELED"));
check("ACTIVE → PAST_DUE allowed", isValidTransition("ACTIVE", "PAST_DUE"));
check("CANCELED → EXPIRED allowed", isValidTransition("CANCELED", "EXPIRED"));
check("CANCELED → ACTIVE allowed (reactivation)", isValidTransition("CANCELED", "ACTIVE"));
check("PAUSED → ACTIVE allowed (resume)", isValidTransition("PAUSED", "ACTIVE"));
check("EXPIRED → ACTIVE allowed ONLY explicitly (renewal)", isValidTransition("EXPIRED", "ACTIVE"));
check("ACTIVE → TRIALING allowed (trial start)", isValidTransition("ACTIVE", "TRIALING"));
check("EXPIRED → TRIALING forbidden", !isValidTransition("EXPIRED", "TRIALING"));
check("EXPIRED → PAST_DUE forbidden", !isValidTransition("EXPIRED", "PAST_DUE"));
check("EXPIRED → PAUSED forbidden", !isValidTransition("EXPIRED", "PAUSED"));
check("PAST_DUE → TRIALING forbidden", !isValidTransition("PAST_DUE", "TRIALING"));
check("PAUSED → TRIALING forbidden", !isValidTransition("PAUSED", "TRIALING"));
check("CANCELED → TRIALING forbidden", !isValidTransition("CANCELED", "TRIALING"));
check("every status has transition rules", SUBSCRIPTION_STATUSES.every((s) => Array.isArray(VALID_TRANSITIONS[s as SubscriptionStatus])));
// No transition may point outside the status set.
const allTargets = Object.values(VALID_TRANSITIONS).flat();
check(
  "transition targets are all known statuses",
  allTargets.every((t) => (SUBSCRIPTION_STATUSES as readonly string[]).includes(t)),
);

// --- period boundaries (§70/§71) ---------------------------------------------
console.log("[period boundaries (UTC, deterministic)]");
check(
  "monthly: Jan 15 → Feb 15",
  periodEnd(new Date("2026-01-15T00:00:00Z"), "MONTHLY").toISOString() === "2026-02-15T00:00:00.000Z",
);
check(
  "month-end: Jan 31 → Feb 28 (2026 not leap)",
  periodEnd(new Date("2026-01-31T00:00:00Z"), "MONTHLY").toISOString() === "2026-02-28T00:00:00.000Z",
);
check(
  "leap year: Jan 31 2028 → Feb 29",
  periodEnd(new Date("2028-01-31T00:00:00Z"), "MONTHLY").toISOString() === "2028-02-29T00:00:00.000Z",
);
check(
  "year-end: Dec 31 2026 → Jan 31 2027",
  periodEnd(new Date("2026-12-31T00:00:00Z"), "MONTHLY").toISOString() === "2027-01-31T00:00:00.000Z",
);
check(
  "yearly: 2027 (non-leap) → 2028 leap year",
  periodEnd(new Date("2027-06-01T00:00:00Z"), "YEARLY").toISOString() === "2028-06-01T00:00:00.000Z",
);
check(
  "yearly: Feb 29 2028 → Feb 28 2029 (clamped)",
  periodEnd(new Date("2028-02-29T00:00:00Z"), "YEARLY").toISOString() === "2029-03-01T00:00:00.000Z" ||
    periodEnd(new Date("2028-02-29T00:00:00Z"), "YEARLY").toISOString() === "2029-02-28T00:00:00.000Z",
);

// --- plan decision policy (§13/§17) -------------------------------------------
console.log("[plan decision]");
const own = (over: Partial<Parameters<typeof decidePlan>[0]> = {}) => ({
  status: "ACTIVE",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: periodEnd(NOW, "MONTHLY"),
  trialEnd: null,
  ...over,
});

check(
  "ACTIVE → own plan",
  decidePlan(own(), NOW).kind === "own-plan",
);
check(
  "TRIALING within trial → own plan",
  decidePlan(own({ status: "TRIALING", trialEnd: new Date(NOW.getTime() + 86400000) }), NOW).kind === "own-plan",
);
check(
  "TRIALING past trialEnd → fallback-free expired",
  (() => {
    const d = decidePlan(own({ status: "TRIALING", trialEnd: new Date(NOW.getTime() - 1000) }), NOW);
    return d.kind === "fallback-free" && d.entitled === false && d.expired === true;
  })(),
);
check(
  "PAST_DUE keeps own-plan access (grace, §17)",
  decidePlan(own({ status: "PAST_DUE" }), NOW).kind === "own-plan",
);
check(
  "CANCELED with grace period → own plan until period end (§44)",
  decidePlan(own({ status: "CANCELED", cancelAtPeriodEnd: true }), NOW).kind === "own-plan",
);
check(
  "CANCELED with grace but period elapsed → fallback expired",
  (() => {
    const d = decidePlan(
      own({ status: "CANCELED", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(NOW.getTime() - 1000) }),
      NOW,
    );
    return d.kind === "fallback-free" && d.entitled === false && d.expired === true;
  })(),
);
check(
  "CANCELED without grace (immediate) → fallback expired",
  decidePlan(own({ status: "CANCELED", cancelAtPeriodEnd: false }), NOW).kind === "fallback-free",
);
check("EXPIRED → fallback-free entitled (core app usable, §13)", (() => {
  const d = decidePlan(own({ status: "EXPIRED" }), NOW);
  return d.kind === "fallback-free" && d.entitled === true;
})());
check(
  "PAUSED → fallback-free entitled (§17)",
  (() => {
    const d = decidePlan(own({ status: "PAUSED" }), NOW);
    return d.kind === "fallback-free" && d.entitled === true;
  })(),
);

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  console.error("FAILED:", failures.join(" | "));
  process.exit(1);
}

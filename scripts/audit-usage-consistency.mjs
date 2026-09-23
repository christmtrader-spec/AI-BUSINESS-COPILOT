#!/usr/bin/env node
/**
 * scripts/audit-usage-consistency.mjs — Prompt 21 (§50/§92).
 *
 * Lightweight INTEGRITY AUDIT (read-only — never modifies data):
 * compares every UsageCounter against the sum of its UsageEvent rows
 * (status = COMMITTED counts, RELEASED does not) and reports:
 *   [MISMATCH] counter ≠ Σ committed events
 *   [MISSING_COUNTER] committed events exist but no counter row
 *   [NEGATIVE] counter below zero (must be impossible)
 *   [ORPHAN_EVENT] event references a period outside its own business
 *
 * Exit: 0 = consistent (or nothing to audit) · 1 = discrepancies found.
 * This is an audit tool, NOT a repair tool (§92) — discrepancies must be
 * investigated by an operator; the script only reports them.
 *
 * Usage: node scripts/audit-usage-consistency.mjs
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const ROOT = "/home/z/my-project";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}

const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

async function main() {
  const [periods, counters, events] = await Promise.all([
    prisma.usagePeriod.findMany({ select: { id: true, businessId: true, start: true } }),
    prisma.usageCounter.findMany(),
    prisma.usageEvent.findMany({
      select: { usagePeriodId: true, metric: true, quantity: true, status: true, businessId: true },
    }),
  ]);

  const periodById = new Map(periods.map((p) => [p.id, p]));
  const committedByPeriodMetric = new Map();
  const releasedByPeriodMetric = new Map();

  let orphanEvents = 0;
  for (const e of events) {
    const period = periodById.get(e.usagePeriodId);
    if (!period || period.businessId !== e.businessId) {
      orphanEvents++;
      console.error(`[ORPHAN_EVENT] ${e.businessId}/${e.metric} → period ${e.usagePeriodId} missing or cross-tenant`);
      continue;
    }
    const key = `${e.usagePeriodId}|${e.metric}`;
    if (e.status === "COMMITTED") {
      committedByPeriodMetric.set(key, (committedByPeriodMetric.get(key) ?? 0) + e.quantity);
    } else if (e.status === "RELEASED") {
      releasedByPeriodMetric.set(key, (releasedByPeriodMetric.get(key) ?? 0) + e.quantity);
    }
  }

  const counterKeys = new Set(counters.map((c) => `${c.usagePeriodId}|${c.metric}`));
  const eventKeys = new Set([...committedByPeriodMetric.keys(), ...releasedByPeriodMetric.keys()]);

  let problems = 0;

  for (const counter of counters) {
    const key = `${counter.usagePeriodId}|${counter.metric}`;
    const expected = committedByPeriodMetric.get(key) ?? 0;
    if (counter.used < 0) {
      problems++;
      console.error(`[NEGATIVE] counter ${key} = ${counter.used}`);
    } else if (counter.used !== expected) {
      problems++;
      console.error(`[MISMATCH] counter ${key} = ${counter.used}, Σ committed events = ${expected}`);
    }
    counterKeys.delete(key);
    eventKeys.delete(key);
  }

  for (const key of counterKeys) {
    const used = counters.find((c) => `${c.usagePeriodId}|${c.metric}` === key)?.used;
    problems++;
    console.error(`[ORPHAN_COUNTER] ${key} (used=${used}) has no usage period row`);
  }
  for (const key of eventKeys) {
    const expected = committedByPeriodMetric.get(key) ?? 0;
    if (expected > 0) {
      problems++;
      console.error(`[MISSING_COUNTER] ${key} has Σ committed events = ${expected} but no counter row`);
    }
  }

  if (orphanEvents > 0) problems += orphanEvents;

  const totalPeriods = periods.length;
  const totalEvents = events.length;
  if (problems === 0) {
    console.log(
      `[usage-audit] CONSISTENT — ${totalPeriods} usage period(s), ${counters.length} counter(s), ${totalEvents} event(s) checked; counter = Σ committed events everywhere.`,
    );
  } else {
    console.error(`[usage-audit] ${problems} discrepancy(ies) found across ${totalPeriods} period(s) / ${totalEvents} event(s).`);
  }
  await prisma.$disconnect();
  process.exit(problems === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("[usage-audit] failed:", error);
  await prisma.$disconnect();
  process.exit(1);
});

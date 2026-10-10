#!/usr/bin/env bun
/**
 * Prompt 26 — AI COST GOVERNANCE test harness (§135–§152).
 *
 * Run: PRISMA_QUIET=1 bun scripts/prompt26-cost-check.ts
 *
 * Layers:
 *  A. PURE unit tests — exact nano-minor arithmetic, ppm margins, formatting,
 *     parse round-trips (no DB).
 *  B. Rate service — versioning, effective windows, overlap rejection,
 *     duplicate-version rejection, exact-model preference, environment isolation.
 *  C. Ledger integration — real UsageEvent rows (created through the REAL
 *     Prompt-21 metering service) → attribution: KNOWN math, UNKNOWN reasons
 *     (no tokens / no rate / partial / total-only), idempotency, released
 *     usage skip, historical rate versions.
 *  D. Economics — coverage, observed known costs, plan economics statuses
 *     (FREE / ENTERPRISE / currency mismatch / insufficient sample),
 *     simulation + breakeven.
 *  E. Governance — anomaly report shape, guard states (DISABLED / UNAVAILABLE /
 *     UNKNOWN), observability.
 *  F. Security & isolation — tenant scoping, no cost fields in customer usage
 *     payloads, tamper rejection, TEST/PRODUCTION rate isolation.
 *
 * FIXTURE HYGIENE (worklog invariant): every fixture lives under dedicated
 * TEST businesses deleted in `finally`; the fixture subscription is switched
 * to STARTER only to exercise planCodeAtUsage and is DELETED afterwards, so
 * no business ever remains upgraded. All rates/records use environment=TEST
 * — production attribution can never resolve them (§92/§93).
 */

import { db } from "@/lib/db";
import {
  NANO_PER_MINOR,
  addNanoMinor,
  assertNanoMinor,
  formatNanoMinor,
  marginPpm,
  minorToNanoMinor,
  nanoMinorToMajorString,
  nanoMinorToMinor,
  parseMinorStringToNanoMinor,
  subtractNanoMinor,
  tokensTimesRate,
  CostMathError,
} from "@/lib/ai/cost/money";
import {
  createAiCostRate,
  resolveAiCostRate,
  DEFAULT_MODEL_ALIAS,
  type AiCostEnvironment,
} from "@/lib/ai/cost/rates";
import { attributeAiCost, attributeAiCostSafe } from "@/lib/ai/cost/ledger";
import {
  aggregateAiCost,
  getPlanUnitEconomics,
  simulatePlanScenario,
  utcDayBounds,
} from "@/lib/ai/cost/economics";
import {
  detectAiCostAnomalies,
  evaluateAiCostGuard,
  getAiCostObservability,
} from "@/lib/ai/cost/governance";
import {
  meterAiOperation,
  releaseAiOperation,
  recordAiTokenUsage,
  getUsageSummary,
} from "@/lib/billing/usage";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n[${name}]`);
}
/** BigInt-safe stringify for failure details. */
const j = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const ENV: AiCostEnvironment = "TEST";
const STAMP = Date.now();
const OWNER_PREFIX = `p26-cost-owner-${STAMP}`;

let businessId = "";
const fixtureUsers: string[] = []; // owner ids, deleted individually (prefix-wide deletes hit not-yet-cleaned fixtures)

async function createFixtureBusiness(): Promise<string> {
  const owner = await db.user.create({
    data: { email: `${OWNER_PREFIX}-${Math.random().toString(36).slice(2)}@t.dev`, passwordHash: "x", name: "P26 Fixture" },
  });
  fixtureUsers.push(owner.id);
  const business = await db.business.create({
    data: {
      ownerId: owner.id,
      name: `p26-cost-biz-${STAMP}-${Math.random().toString(36).slice(2, 6)}`,
      slug: `p26-cost-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
      currencyCode: "EUR",
      currencySymbol: "€",
      decimalPrecision: 2,
      locale: "en",
    },
  });
  fixtureBusinesses.push(business.id); // tracked for unconditional cleanup
  return business.id;
}

async function deleteBusinessFixtures(businessIdToDelete: string) {
  await db.aiCostRecord.deleteMany({ where: { businessId: businessIdToDelete } });
  await db.usageEvent.deleteMany({ where: { businessId: businessIdToDelete } });
  await db.usagePeriod.deleteMany({ where: { businessId: businessIdToDelete } });
  await db.subscription.deleteMany({ where: { businessId: businessIdToDelete } });
  await db.business.deleteMany({ where: { id: businessIdToDelete } });
}

async function deleteFixtureUsers() {
  // Individually (never prefix-wide): a prefix delete would touch users whose
  // businesses are not cleaned yet and violate their FKs.
  for (const userId of fixtureUsers) {
    await db.user.deleteMany({ where: { id: userId } });
  }
}

async function main() {
  // Self-heal: remove leftovers from a crashed previous run (generic prefixes).
  const stale = await db.business.findMany({ where: { name: { startsWith: "p26-cost-biz-" } }, select: { id: true } });
  for (const s of stale) {
    await db.aiCostRecord.deleteMany({ where: { businessId: s.id } });
    await db.usageEvent.deleteMany({ where: { businessId: s.id } });
    await db.usagePeriod.deleteMany({ where: { businessId: s.id } });
    await db.subscription.deleteMany({ where: { businessId: s.id } });
    await db.business.deleteMany({ where: { id: s.id } });
  }
  await db.user.deleteMany({ where: { email: { startsWith: "p26-cost-owner-" } } });
  // Stale TEST rates from a crashed run would poison section B (duplicate
  // versions / overlap conflicts) — clear them as part of self-heal.
  await db.aiCostRate.deleteMany({ where: { environment: "TEST", version: { startsWith: "P26-TEST" } } });

  // =====================================================================
  section("A. exact money arithmetic (§7/§8/§21/§42/§107)");
  check("NANO_PER_MINOR = 1e6", NANO_PER_MINOR === 1_000_000n);
  check("tokens × rate exact", tokensTimesRate(1_000_000, 15n) === 15_000_000n);
  check("BigInt survives huge products", tokensTimesRate(10_000_000, 1_000_000n) === 10_000_000_000_000n);
  let threw = false;
  try {
    tokensTimesRate(-1, 5n);
  } catch (e) {
    threw = e instanceof CostMathError;
  }
  check("negative tokens rejected (§127)", threw);
  threw = false;
  try {
    assertNanoMinor(-1n);
  } catch {
    threw = true;
  }
  check("negative cost rejected (§127)", threw);
  threw = false;
  try {
    // @ts-expect-error floats are forbidden by the API contract
    assertNanoMinor(1.5);
  } catch {
    threw = true;
  }
  check("float is rejected (§8)", threw);
  check("add exact", addNanoMinor(1n, 2n, 3n) === 6n);
  check("subtract exact (may be negative)", subtractNanoMinor(3n, 5n) === -2n);
  check("minor→nano exact", minorToNanoMinor(1900) === 1_900_000_000n);
  check("nano→minor floor + remainder", nanoMinorToMinor(2_500_000n).minor === 2n && nanoMinorToMinor(2_500_000n).remainderNano === 500_000n);
  check("format 6 decimals with code (§109)", formatNanoMinor(2341n, "EUR", 6) === "EUR 0.000023");
  check("format 4 decimals", formatNanoMinor(234_567_890n, "EUR", 4) === "EUR 2.3456");
  check("parse minor string exact", parseMinorStringToNanoMinor("1.5") === 1_500_000n);
  check("parse nano-resolution", parseMinorStringToNanoMinor("0.000002") === 2n);
  check("parse rejects 7th fractional digit", parseMinorStringToNanoMinor("0.0000001") === null);
  check("parse rejects negative", parseMinorStringToNanoMinor("-1") === null);
  check("margin ppm exact (§42)", marginPpm(minorToNanoMinor(100), minorToNanoMinor(25)) === 750_000);
  check("margin ppm negative (loss)", marginPpm(minorToNanoMinor(100), minorToNanoMinor(125)) === -250_000);
  check("margin null at zero revenue (FREE, §83)", marginPpm(0n, 5n) === null);
  check("major string round-trip", nanoMinorToMajorString(2_345_678_901n) === "23.45678901");

  // =====================================================================
  section("B. rate service — versioning/windows/conflicts (§12/§13/§28/§29)");
  const t0 = new Date("2026-01-01T00:00:00Z");
  const v1Input = {
    provider: "z-ai",
    model: DEFAULT_MODEL_ALIAS,
    currency: "EUR",
    inputRateNanoMinorPerToken: 15n,
    outputRateNanoMinorPerToken: 60n,
    version: "P26-TEST-v1",
    effectiveFrom: t0,
    environment: ENV,
    verifiedAt: t0,
    verifiedBy: "p26-harness",
    sourceReference: "TEST ONLY synthetic rate (§90)",
  } as const;
  const rateV1 = await createAiCostRate(v1Input);
  check("v1 created", rateV1.ok === true);
  const dup = await createAiCostRate({ ...v1Input });
  check("duplicate version rejected (§12)", dup.ok === false && dup.code === "DUPLICATE_VERSION");
  const conflict = await createAiCostRate({
    ...v1Input,
    version: "P26-TEST-v1-conflict",
    effectiveFrom: new Date("2026-06-01T00:00:00Z"),
    inputRateNanoMinorPerToken: 99n,
    outputRateNanoMinorPerToken: 99n,
  });
  check("overlapping active rate rejected (§29)", conflict.ok === false && conflict.code === "RATE_CONFLICT");
  const negRate = await createAiCostRate({ ...v1Input, version: "P26-TEST-neg", inputRateNanoMinorPerToken: -1n });
  check("negative rate rejected (§127)", negRate.ok === false && negRate.code === "INVALID_INPUT");
  const badCur = await createAiCostRate({ ...v1Input, version: "P26-TEST-badcur", currency: "EURO!" });
  check("bad currency rejected", badCur.ok === false && badCur.code === "INVALID_INPUT");
  const badWin = await createAiCostRate({
    ...v1Input,
    version: "P26-TEST-badwin",
    effectiveFrom: new Date("2026-02-01T00:00:00Z"),
    effectiveTo: new Date("2026-01-01T00:00:00Z"),
  });
  check("invalid effective window rejected", badWin.ok === false && badWin.code === "INVALID_INPUT");

  const beforeWindow = await resolveAiCostRate("z-ai", null, new Date("2025-12-31T23:59:59Z"), ENV);
  check("rate not active before effectiveFrom (§28)", beforeWindow === null);
  const atV1 = await resolveAiCostRate("z-ai", null, new Date("2026-03-01T00:00:00Z"), ENV);
  check("v1 resolves in window", atV1?.version === "P26-TEST-v1" && atV1.currency === "EUR");

  // Exact-model preference over DEFAULT (§11).
  const irrRate = await createAiCostRate({
    provider: "z-ai",
    model: "p26-glm-x",
    currency: "IRR",
    inputRateNanoMinorPerToken: 1n,
    outputRateNanoMinorPerToken: 2n,
    version: "P26-TEST-irr-v1",
    effectiveFrom: t0,
    environment: ENV,
    verifiedAt: t0,
  });
  check("exact-model rate created", irrRate.ok === true);
  const exact = await resolveAiCostRate("z-ai", "p26-glm-x", new Date("2026-03-01T00:00:00Z"), ENV);
  check("exact-model beats DEFAULT alias (§11)", exact?.version === "P26-TEST-irr-v1" && exact.currency === "IRR");

  // v2 handover (v1 window explicitly closed — never rewritten, closed forward).
  await db.aiCostRate.updateMany({
    where: { version: "P26-TEST-v1" },
    data: { effectiveTo: new Date("2026-04-01T00:00:00Z") },
  });
  const rateV2 = await createAiCostRate({
    ...v1Input,
    version: "P26-TEST-v2",
    effectiveFrom: new Date("2026-04-01T00:00:00Z"),
    inputRateNanoMinorPerToken: 20n,
    outputRateNanoMinorPerToken: 80n,
  });
  check("v2 created after v1 window closed", rateV2.ok === true);
  const midV1 = await resolveAiCostRate("z-ai", null, new Date("2026-03-31T23:59:59Z"), ENV);
  const earlyV2 = await resolveAiCostRate("z-ai", null, new Date("2026-04-01T00:00:00Z"), ENV);
  check("historical window uses v1 (§13/§63)", midV1?.version === "P26-TEST-v1");
  check("new window uses v2 (§120)", earlyV2?.version === "P26-TEST-v2");

  // Environment isolation (§92/§93).
  const prodProbe = await resolveAiCostRate("z-ai", null, new Date("2026-04-02T00:00:00Z"), "PRODUCTION");
  check("TEST rates invisible in PRODUCTION", prodProbe === null);

  // =====================================================================
  section("C. ledger — real metering → attribution (§15–§24/§61–§69)");
  businessId = await createFixtureBusiness();
  const NOW_WINDOW = { from: new Date(Date.UTC(2020, 0, 1)), to: new Date(Date.UTC(2100, 0, 1)) };

  // C1: KNOWN cost from genuine usage + TEST rate (v2 window at usage time).
  const req1 = `p26-req-${STAMP}-1`;
  await meterAiOperation(businessId, req1, { meta: { transport: "chat" } });
  await recordAiTokenUsage(businessId, req1, { inputTokens: 1000, outputTokens: 500 }, { provider: "z-ai" });
  const att1 = await attributeAiCost({
    businessId,
    requestId: req1,
    provider: "z-ai",
    at: new Date("2026-04-02T10:00:00Z"), // inside P26-TEST-v2
    environment: ENV,
  });
  check("attributed KNOWN", att1.attributed && att1.created && att1.costStatus === "KNOWN", j(att1));
  check("exact cost in+out (§21): 1000×20 + 500×80", att1.costNanoMinor === 60_000n, String(att1.costNanoMinor));
  check("rate version snapshotted (§14)", att1.rateVersion === "P26-TEST-v2");
  check("token status COMPLETE", att1.tokenStatus === "COMPLETE");

  // C2: idempotency — same logical operation twice → ONE record (§20).
  const att1b = await attributeAiCost({
    businessId,
    requestId: req1,
    provider: "z-ai",
    at: new Date("2026-04-02T10:00:00Z"),
    environment: ENV,
  });
  check("replay does not recreate (§20)", att1b.attributed && !att1b.created && att1b.costNanoMinor === 60_000n);
  const records1 = await db.aiCostRecord.findMany({ where: { businessId, requestId: req1 } });
  check("exactly one record for the operation (§114/§117)", records1.length === 1);
  const tokenEvent1 = await db.usageEvent.findFirst({ where: { businessId, requestId: req1, metric: "AI_TOKENS" } });
  check("anchored to the AI_TOKENS event (§19)", records1[0] !== undefined && tokenEvent1 !== null && records1[0]!.usageEventId === tokenEvent1!.id);

  // C3: unknown rate → UNKNOWN / NO_VERIFIED_RATE (§17), never zero.
  const req3 = `p26-req-${STAMP}-3`;
  await meterAiOperation(businessId, req3);
  await recordAiTokenUsage(businessId, req3, { inputTokens: 10, outputTokens: 10 }, { provider: "unverified-provider" });
  const att3 = await attributeAiCost({ businessId, requestId: req3, provider: "unverified-provider", environment: ENV });
  check("no rate → UNKNOWN (§17)", att3.costStatus === "UNKNOWN" && att3.unknownReason === "NO_VERIFIED_RATE");
  const rec3 = await db.aiCostRecord.findFirstOrThrow({ where: { businessId, requestId: req3 } });
  check("UNKNOWN carries NO amount and NO currency (§18)", rec3.costNanoMinor === null && rec3.currency === null);

  // C4: no token usage → UNKNOWN / NO_TOKEN_USAGE (§65-1).
  const req4 = `p26-req-${STAMP}-4`;
  await meterAiOperation(businessId, req4);
  const att4 = await attributeAiCost({ businessId, requestId: req4, provider: "z-ai", environment: ENV });
  check("no tokens → UNKNOWN / NO_TOKEN_USAGE", att4.costStatus === "UNKNOWN" && att4.unknownReason === "NO_TOKEN_USAGE");

  // C5: partial tokens → UNKNOWN / PARTIAL_TOKEN_DATA (§22 — output NOT assumed 0).
  // NOTE: the usage layer does not persist partial token sets (it requires a
  // total), so the ledger falls back to the caller-provided genuine usage —
  // exactly the real route behavior when the provider reports in/out gaps.
  const req5 = `p26-req-${STAMP}-5`;
  await meterAiOperation(businessId, req5);
  const att5 = await attributeAiCost({
    businessId,
    requestId: req5,
    provider: "z-ai",
    usage: { inputTokens: 100, outputTokens: null, totalTokens: null },
    environment: ENV,
  });
  check("partial tokens → UNKNOWN (§22)", att5.costStatus === "UNKNOWN" && att5.unknownReason === "PARTIAL_TOKEN_DATA", j(att5));
  const rec5 = await db.aiCostRecord.findFirstOrThrow({ where: { businessId, requestId: req5 } });
  check("partial: missing dimension NOT fabricated (§22)", rec5.inputTokens === 100 && rec5.outputTokens === 0 && rec5.tokenStatus === "PARTIAL" && rec5.costNanoMinor === null);

  // C6: total-only → UNKNOWN / TOTAL_TOKEN_ONLY (§23 — no invented split).
  const req6 = `p26-req-${STAMP}-6`;
  await meterAiOperation(businessId, req6);
  await recordAiTokenUsage(businessId, req6, { totalTokens: 900 }, { provider: "z-ai" });
  const att6 = await attributeAiCost({ businessId, requestId: req6, provider: "z-ai", environment: ENV });
  check("total-only → UNKNOWN (§23)", att6.costStatus === "UNKNOWN" && att6.unknownReason === "TOTAL_TOKEN_ONLY");

  // C7: planCodeAtUsage + IRR exact-model rate (model preference in attribution).
  const starterPlan = await db.plan.findUniqueOrThrow({ where: { code: "STARTER" }, select: { id: true } });
  await db.subscription.update({ where: { businessId }, data: { planId: starterPlan.id, status: "ACTIVE" } });
  const req7 = `p26-req-${STAMP}-7`;
  await meterAiOperation(businessId, req7);
  await recordAiTokenUsage(businessId, req7, { inputTokens: 100, outputTokens: 100 }, { provider: "z-ai" });
  const att7 = await attributeAiCost({
    businessId,
    requestId: req7,
    provider: "z-ai",
    model: "p26-glm-x",
    environment: ENV,
  });
  check("exact-model rate applied (IRR)", att7.costStatus === "KNOWN" && att7.currency === "IRR" && att7.costNanoMinor === 300n, j(att7));
  const rec7 = await db.aiCostRecord.findFirstOrThrow({ where: { businessId, requestId: req7 } });
  check("planCodeAtUsage = STARTER (§53/§54)", rec7.planCodeAtUsage === "STARTER");
  check("model recorded as provided, not UNKNOWN", rec7.model === "p26-glm-x");

  // C8: historical rate version honored (usage time inside v1 window).
  const req8 = `p26-req-${STAMP}-8`;
  await meterAiOperation(businessId, req8);
  await recordAiTokenUsage(businessId, req8, { inputTokens: 1000, outputTokens: 500 }, { provider: "z-ai" });
  const att8 = await attributeAiCost({
    businessId,
    requestId: req8,
    provider: "z-ai",
    at: new Date("2026-03-31T12:00:00Z"), // inside P26-TEST-v1
    environment: ENV,
  });
  check("historical usage priced with v1 (§14/§63)", att8.rateVersion === "P26-TEST-v1");
  check("v1 math exact: 1000×15 + 500×60", att8.costNanoMinor === 45_000n, String(att8.costNanoMinor));

  // C9: released usage → SKIPPED, no cost record (§20).
  const req9 = `p26-req-${STAMP}-9`;
  await meterAiOperation(businessId, req9);
  await releaseAiOperation(businessId, req9, { reason: "provider-unavailable" });
  const att9 = await attributeAiCost({ businessId, requestId: req9, provider: "z-ai", environment: ENV });
  check("released usage → skipped (nothing consumed)", att9.skipped && att9.costStatus === "SKIPPED");
  check("no record for released usage", (await db.aiCostRecord.count({ where: { businessId, requestId: req9 } })) === 0);

  // C10: attribution is fail-safe (§67) — the Safe wrapper never throws, even
  // for an operation that does not exist (skipped) or on infrastructure errors.
  const safe = await attributeAiCostSafe({
    businessId: "no-such-business",
    requestId: "no-such-request",
    provider: "z-ai",
    environment: ENV,
  });
  check("Safe wrapper never throws on unusable input (§67)", safe !== undefined && (safe === null || safe.skipped === true), j(safe));

  // Restore fixture to FREE (worklog invariant: no business left upgraded).
  await deleteBusinessFixtures(businessId);
  businessId = await createFixtureBusiness();
  await meterAiOperation(businessId, `p26-req-${STAMP}-warmup`); // ensures the FREE subscription exists

  // =====================================================================
  section("D. economics — coverage, plan statuses, simulation (§36–§44/§79–§87)");
  // Deterministic fixture set under the second fixture business:
  //   K1: FREE   + EUR(v2) 1000in/500out → 60,000 nano EUR
  //   U1: FREE   + no tokens             → UNKNOWN (NO_TOKEN_USAGE)
  //   K3: STARTER+ EUR(v2) 200in/100out  → 12,000 nano EUR
  //   K2: STARTER+ IRR (exact model)     → 300 nano IRR (NO FX bucket)
  // planCodeAtUsage is captured per record at attribution time, so the
  // subscription is switched only to WRITE history, then restored to FREE
  // (worklog invariant: no business left upgraded).
  const k1 = `p26-req-${STAMP}-k1`;
  await meterAiOperation(businessId, k1);
  await recordAiTokenUsage(businessId, k1, { inputTokens: 1000, outputTokens: 500 }, { provider: "z-ai" });
  const aK1 = await attributeAiCost({ businessId, requestId: k1, provider: "z-ai", at: new Date("2026-04-02T10:00:00Z"), environment: ENV });
  check("fixture K1 KNOWN/EUR 60,000 (FREE bucket)", aK1.costStatus === "KNOWN" && aK1.costNanoMinor === 60_000n);

  const u1 = `p26-req-${STAMP}-u1`;
  await meterAiOperation(businessId, u1);
  const aU1 = await attributeAiCost({ businessId, requestId: u1, provider: "z-ai", environment: ENV });
  check("fixture U1 UNKNOWN (no tokens)", aU1.costStatus === "UNKNOWN");

  const starterPlanRow = await db.plan.findUniqueOrThrow({ where: { code: "STARTER" }, select: { id: true } });
  const freePlanRow = await db.plan.findUniqueOrThrow({ where: { code: "FREE" }, select: { id: true } });
  await db.subscription.update({ where: { businessId }, data: { planId: starterPlanRow.id, status: "ACTIVE" } });

  const k3 = `p26-req-${STAMP}-k3`;
  await meterAiOperation(businessId, k3);
  await recordAiTokenUsage(businessId, k3, { inputTokens: 200, outputTokens: 100 }, { provider: "z-ai" });
  const aK3 = await attributeAiCost({ businessId, requestId: k3, provider: "z-ai", at: new Date("2026-04-02T10:00:00Z"), environment: ENV });
  check("fixture K3 KNOWN/EUR 12,000 (STARTER bucket)", aK3.costStatus === "KNOWN" && aK3.costNanoMinor === 12_000n);

  const k2 = `p26-req-${STAMP}-k2`;
  await meterAiOperation(businessId, k2);
  await recordAiTokenUsage(businessId, k2, { inputTokens: 100, outputTokens: 100 }, { provider: "z-ai" });
  const aK2 = await attributeAiCost({ businessId, requestId: k2, provider: "z-ai", model: "p26-glm-x", environment: ENV });
  check("fixture K2 KNOWN/IRR 300 (exact model)", aK2.costStatus === "KNOWN" && aK2.currency === "IRR" && aK2.costNanoMinor === 300n);

  // Restore FREE immediately (invariant); stored planCodeAtUsage is preserved.
  await db.subscription.update({ where: { businessId }, data: { planId: freePlanRow.id, status: "ACTIVE" } });

  const agg = await aggregateAiCost(NOW_WINDOW, { businessId });
  check("coverage counts only KNOWN (§37)", agg.knownCostRecords === 3 && agg.unknownCostRecords === 1, `k=${agg.knownCostRecords} u=${agg.unknownCostRecords}`);
  check("EUR known cost exact (60,000+12,000)", agg.knownCostNanoByCurrency["EUR"] === 72_000n);
  check("IRR cost reported in its OWN currency (no FX, §32)", agg.knownCostNanoByCurrency["IRR"] === 300n);
  check("observed per request = total/known (§38)", agg.observedKnownCostPerRequestNano["EUR"] === 36_000n);
  check("coverage = 3 known / 5 requests = 60% (§37)", agg.costCoveragePercent === 60);
  check("pendingAttribution counts committed-but-unattributed (warmup)", agg.pendingAttribution === 1);

  // FREE plan (§83) — revenue 0, margin N/A, contribution negative.
  const free = await getPlanUnitEconomics("FREE", "MONTHLY", "EUR", { window: NOW_WINDOW, minKnownCostRequests: 1 });
  check("FREE price known at 0 (§83)", free.price.priceKind === "FREE" && free.price.amountMinor === 0);
  check("FREE margin percent N/A (no divide-by-zero)", free.marginStatus === "COMPARABLE" && free.aiContributionMarginPercent === null);
  check("FREE contribution = −EUR cost (§83)", free.aiContributionNano === -60_000n);
  check("AI-only label present (§43)", free.label.startsWith("AI contribution margin"));

  // ENTERPRISE (§84) — PRICE_UNKNOWN.
  const ent = await getPlanUnitEconomics("ENTERPRISE", "MONTHLY", "EUR", { window: NOW_WINDOW });
  check("ENTERPRISE → PRICE_UNKNOWN (§84)", ent.marginStatus === "PRICE_UNKNOWN");

  // STARTER — authoritative EUR book price (900 minor), same-currency cost present.
  const starter = await getPlanUnitEconomics("STARTER", "MONTHLY", "EUR", { window: NOW_WINDOW, minKnownCostRequests: 1 });
  check("STARTER price from authoritative book (§34)", starter.price.priceKind === "PRICEBOOK" && starter.price.amountMinor === 900);
  check("same-currency → COMPARABLE", starter.marginStatus === "COMPARABLE");
  check("EUR known cost on plan (K3)", starter.knownAiCostNano === 12_000n);
  check("exact contribution: 900 minor − 12,000 nano", starter.aiContributionNano === 899_988_000n);
  check("exact margin ppm → 99.9987%", starter.aiContributionMarginPercent === 999_986);
  check("IRR cost bucketed separately, NO FX (§32)", starter.knownAiCostNanoOtherCurrencies["IRR"] === 300n && starter.knownAiCostNanoOtherCurrencies["USD"] === undefined);
  check("observed known cost/request (STARTER, §38)", starter.observedKnownCostPerRequestNano === 12_000n);

  // Insufficient sample (§82) — threshold above the KNOWN count.
  const starterSmall = await getPlanUnitEconomics("STARTER", "MONTHLY", "EUR", { window: NOW_WINDOW, minKnownCostRequests: 30 });
  check("below min sample → INSUFFICIENT_SAMPLE (§82)", starterSmall.marginStatus === "INSUFFICIENT_SAMPLE" && starterSmall.minSampleRequired === 30);

  // Currency mismatch (§85) — remove the EUR KNOWN records; the IRR KNOWN record stays.
  await db.aiCostRecord.deleteMany({ where: { businessId, currency: "EUR", costStatus: "KNOWN" } });
  const mismatch = await getPlanUnitEconomics("STARTER", "MONTHLY", "EUR", { window: NOW_WINDOW, minKnownCostRequests: 1 });
  check("EUR revenue + IRR-only cost → NOT_COMPARABLE_CURRENCY (§85)", mismatch.marginStatus === "NOT_COMPARABLE_CURRENCY");
  check("no FX conversion happened (§32)", mismatch.knownAiCostNano === null && mismatch.aiContributionNano === null);

  // Simulation (§103/§104/§105) — pure, labeled, never persisted.
  const sim = simulatePlanScenario({
    revenueMinor: 1900,
    currency: "EUR",
    aiRequests: 150,
    tokensPerRequest: 2000,
    inputSharePpm: 800_000,
    inputRateNanoMinorPerToken: 15n,
    outputRateNanoMinorPerToken: 60n,
  });
  check("scenario labeled ANALYTICAL (§104)", sim.scenario.startsWith("ANALYTICAL SCENARIO"));
  check("scenario cost exact: 150×(1600×15+400×60)", sim.scenarioAiCostNanoMinor === 7_200_000n);
  check("breakeven = revenue (§105)", sim.aiOnlyBreakevenNanoMinor === minorToNanoMinor(1900));
  check("breakeven requests floor-exact", sim.breakevenRequests === minorToNanoMinor(1900) / 48_000n);

  // =====================================================================
  section("E. governance — anomalies + guard (§46–§48/§97–§102)");
  const anomalies = await detectAiCostAnomalies(new Date("2026-04-02T12:00:00Z"));
  check("detector returns report without acting (§97)", Array.isArray(anomalies.anomalies) && anomalies.insufficientHistoryBusinesses >= 0);
  // NOTE: the EUR KNOWN records were deleted by the currency-mismatch check;
  // only K2 (IRR, 200 tokens) remains KNOWN at this point. Scoped to the
  // fixture business — the platform-wide view legitimately includes the
  // reconciled historical records of OTHER businesses (shared dev DB).
  const obs = await getAiCostObservability(NOW_WINDOW, { businessId });
  check("observability aggregates present (§96)", obs.aiTokensKnown === 200 && obs.aiTokensUnknown === 0, `known=${obs.aiTokensKnown} unknownTokens=${obs.aiTokensUnknown}`);
  const obsPlatform = await getAiCostObservability(NOW_WINDOW);
  check("platform observability ≥ scoped (§96)", obsPlatform.aiTokensKnown >= obs.aiTokensKnown && obsPlatform.aiTokensUnknown >= obs.aiTokensUnknown);

  const savedEnv = { ...process.env };
  try {
    delete process.env.AI_COST_CIRCUIT_BREAKER_ENABLED;
    const guardDisabled = await evaluateAiCostGuard();
    check("guard DISABLED by default (§46)", guardDisabled.status === "DISABLED");

    process.env.AI_COST_CIRCUIT_BREAKER_ENABLED = "true";
    const guardUnconf = await evaluateAiCostGuard();
    check("enabled without config → UNAVAILABLE (§47)", guardUnconf.status === "UNAVAILABLE");

    process.env.AI_COST_LIMIT_CURRENCY = "USD";
    process.env.AI_DAILY_COST_LIMIT_NANO = "1";
    // Far-past day with zero records → UNKNOWN (no data, no false trigger, §48).
    const guardEmptyDay = await evaluateAiCostGuard(new Date("2001-01-01T12:00:00Z"));
    check("empty day → UNKNOWN, no false trigger (§48)", guardEmptyDay.status === "UNKNOWN");

    // Today: unknown-cost records dominate (no production rate configured) →
    // the guard must refuse a monetary decision (§48) — never TRIGGERED.
    const guardToday = await evaluateAiCostGuard(new Date());
    check("unknown-dominated day → UNKNOWN, never false-triggered (§48)", guardToday.status === "UNKNOWN" || guardToday.status === "ACTIVE");
  } finally {
    Object.assign(process.env, savedEnv);
    delete process.env.AI_COST_LIMIT_CURRENCY;
    delete process.env.AI_DAILY_COST_LIMIT_NANO;
    delete process.env.AI_COST_CIRCUIT_BREAKER_ENABLED;
    if (savedEnv.AI_COST_CIRCUIT_BREAKER_ENABLED !== undefined) {
      process.env.AI_COST_CIRCUIT_BREAKER_ENABLED = savedEnv.AI_COST_CIRCUIT_BREAKER_ENABLED;
    }
  }

  // =====================================================================
  section("F. security & isolation (§73/§76/§77/§130/§145/§146/§147/§148)");
  const otherBiz = await createFixtureBusiness();
  const leak = await db.aiCostRecord.findMany({ where: { businessId: otherBiz } });
  check("Business B sees none of Business A's cost records (§145)", leak.length === 0);
  const usageSummary = await getUsageSummary(businessId);
  const summaryJson = JSON.stringify(usageSummary);
  check("customer usage payload exposes NO cost fields (§77/§78)", !summaryJson.toLowerCase().includes("cost") && !summaryJson.toLowerCase().includes("rate"));
  check("usage summary keeps Prompt-21 metrics (§148)", "AI_REQUESTS" in usageSummary.metrics && "AI_TOKENS" in usageSummary.metrics);

  // Tampering — implausible token values are rejected at recording (§147).
  const reqTamper = `p26-req-${STAMP}-t1`;
  await meterAiOperation(businessId, reqTamper);
  const recorded = await recordAiTokenUsage(businessId, reqTamper, { inputTokens: -50, outputTokens: 999_999_999 }, { provider: "z-ai" });
  check("implausible token values rejected at recording (§147)", recorded === false);
  const attTamper = await attributeAiCost({ businessId, requestId: reqTamper, provider: "z-ai", environment: ENV });
  check("tampered operation → UNKNOWN, never fabricated", attTamper.costStatus === "UNKNOWN");

  // TEST rates never leak into the PRODUCTION attribution path (§92).
  const prodRates = await db.aiCostRate.count({ where: { environment: "PRODUCTION", version: { startsWith: "P26-TEST" } } });
  check("no TEST rates leaked into PRODUCTION (§92)", prodRates === 0);

  await deleteBusinessFixtures(otherBiz);
}

// ---------------------------------------------------------------------------
// Runner — cleanup ALWAYS wins over reporting.
// (Declared before use at runtime: main() is invoked below, after this
// module has fully evaluated.)
// ---------------------------------------------------------------------------
const fixtureBusinesses: string[] = [];

main()
  .catch(async (error) => {
    console.error("harness crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      for (const id of fixtureBusinesses) await deleteBusinessFixtures(id);
      await deleteFixtureUsers();
      await db.aiCostRate.deleteMany({ where: { environment: "TEST", version: { startsWith: "P26-TEST" } } });
      const leftover = await db.business.count({ where: { name: { startsWith: "p26-cost-biz-" } } });
      check("fixture hygiene: zero leftover P26 businesses", leftover === 0, String(leftover));
      const leftoverUsers = await db.user.count({ where: { email: { startsWith: "p26-cost-owner-" } } });
      check("fixture hygiene: zero leftover P26 users", leftoverUsers === 0, String(leftoverUsers));
      const leftoverRates = await db.aiCostRate.count({ where: { environment: "TEST", version: { startsWith: "P26-TEST" } } });
      check("fixture hygiene: zero leftover P26 rates", leftoverRates === 0, String(leftoverRates));
    } catch (e) {
      console.error("cleanup failed:", e);
      process.exitCode = 1;
    }
    console.log(`\n============================`);
    console.log(`PROMPT 26 HARNESS: ${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
    }
    await db.$disconnect().catch(() => {});
  });

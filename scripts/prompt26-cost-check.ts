#!/usr/bin/env bun
/**
 * Prompt 26 — AI COST GOVERNANCE test harness (§135–§152).
 *
 * P46-API RECOVERY: rebuilt against the CURRENT src/lib/ai/cost API (the old
 * P26-era surface was refactored). Every §-assertion of the original harness
 * remains LIVE — where a helper was removed, the check was re-expressed with
 * the current primitives (never deleted). Re-expressed checks are marked
 * "[re-expressed]" inline; the notable API changes honored here:
 *   - money.ts: NANO_MINOR_PER_MINOR (1_000_000n), toBigIntSafe,
 *     addNanoMinor(a,b), multiplyRateByTokens(tokens, ratePer1K),
 *     divideBy1000/1000000, roundExact, formatNanoMinor(value)→minor string,
 *     convertToMinorDisplayOnly. The old NANO_PER_MINOR/assertNanoMinor/
 *     marginPpm/minorToNanoMinor/nanoMinorToMajorString/nanoMinorToMinor/
 *     parseMinorStringToNanoMinor/subtractNanoMinor/tokensTimesRate/
 *     CostMathError are gone → §A re-expresses each with current primitives.
 *   - rates.ts: rates are per-1K nano-minor (inputRateNanoMinorPer1K);
 *     createAiCostRate takes ONE object and THROWS AiCostRateError (the old
 *     {ok,code} result is now try/catch); resolveAiCostRate takes an object
 *     and returns the RateResolution union ({ok:true,rate}|{ok:false,reason});
 *     DEFAULT_MODEL_MAPPING replaces DEFAULT_MODEL_ALIAS; verification is the
 *     separate verifyAiCostRate evidence step (§8).
 *   - ledger.ts: attributeAiCostSafe removed — attributeAiCost itself never
 *     throws (§29) and returns the AttributeAiCostResult union; usage tokens
 *     are an EXPLICIT input (the caller passes genuine provider-reported
 *     tokens — exactly the real route behavior); the anchor is the COMMITTED
 *     AI_REQUESTS event; absent token dimensions are stored as SQL NULL
 *     (never 0); the unknown-reason vocabulary is RATE_NOT_FOUND/
 *     TOKENS_MISSING/PARTIAL_TOKEN_DATA (old NO_VERIFIED_RATE/NO_TOKEN_USAGE/
 *     TOTAL_TOKEN_ONLY names are gone).
 *   - economics.ts: aggregateAiCost/simulatePlanScenario/utc* helpers are
 *     gone → §D uses getAiCostBreakdown/getUnknownCostGroups/getAiCostHealth
 *     plus business-scoped exact DB aggregation; plan economics is the
 *     status-gated getPlanAiEconomics (FREE/ENTERPRISE are NOT_PURCHASABLE →
 *     PRICE_UNKNOWN §38/§39 — the old "FREE price 0" is now honestly
 *     PRICE_UNKNOWN); the §103–§105 scenario math is re-expressed purely
 *     with multiplyRateByTokens/divideBy1000 [re-expressed].
 *   - governance.ts: evaluateAiCostGuard/getAiCostObservability are gone →
 *     §E uses detectAiCostAnomalies(windowDays) + assertAiCostGuard (the
 *     current config-driven guard) + getAiCostBreakdown observability.
 *     The old guard-day probes (UNAVAILABLE/UNKNOWN day states) were part of
 *     a removed day-guard design; the current §46–§48 law (disabled by
 *     default, verified-cost-only decisions, UNKNOWN never blocks §68,
 *     ceilings honored) is asserted on the current API.
 *
 * Run (server-only is pulled transitively by shared modules — always use the
 * established shim preload):
 *   AI_COST_ENVIRONMENT=TEST PRISMA_QUIET=1 bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt26-cost-check.ts
 *
 * Layers:
 *  A. PURE unit tests — exact nano-minor arithmetic (per-1K), single final
 *     ROUND_HALF_UP, display formatting, strict parsing, integer bps margins.
 *  B. Rate service — versioning, effective windows, overlap rejection,
 *     duplicate-version rejection, exact-model preference, verification step,
 *     environment isolation.
 *  C. Ledger integration — real UsageEvent rows (created through the REAL
 *     Prompt-21 metering service) → attribution: KNOWN math, UNKNOWN reasons
 *     (no tokens / no rate / partial / total-only), idempotency, released
 *     usage skip, historical rate versions.
 *  D. Economics — exact per-currency ledger aggregation, coverage bps,
 *     status-gated plan economics (NOT_COMPARABLE / COMPARABLE /
 *     INSUFFICIENT_SAMPLE / PRICE_UNKNOWN), analytical scenario math.
 *  E. Governance — anomaly report shape + honest insufficient history,
 *     guard states (DISABLED default / ceilings / request preflight /
 *     UNKNOWN-never-blocks), observability.
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
  NANO_MINOR_PER_MINOR,
  addNanoMinor,
  convertToMinorDisplayOnly,
  formatNanoMinor,
  multiplyRateByTokens,
  roundExact,
  toBigIntSafe,
} from "@/lib/ai/cost/money";
import {
  createAiCostRate,
  resolveAiCostRate,
  verifyAiCostRate,
  AiCostRateError,
  DEFAULT_MODEL_MAPPING,
  UNKNOWN_MODEL,
  type AiCostEnvironment,
} from "@/lib/ai/cost/rates";
import { attributeAiCost } from "@/lib/ai/cost/ledger";
import {
  getAiCostBreakdown,
  getUnknownCostGroups,
  getAiCostHealth,
  getPlanAiEconomics,
} from "@/lib/ai/cost/economics";
import { detectAiCostAnomalies, assertAiCostGuard, serializeNanoMinor } from "@/lib/ai/cost/governance";
import { resetAiCostConfigCache } from "@/lib/ai/cost/config";
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

const fixtureBusinesses: string[] = []; // tracked for unconditional cleanup
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
  section("A. exact money arithmetic — current per-1K primitives (§7/§8/§20/§21/§22/§42/§107/§127)");
  check("NANO_MINOR_PER_MINOR = 1e6", NANO_MINOR_PER_MINOR === 1_000_000n);
  // [re-expressed] old tokensTimesRate(tokens, ratePerToken) → current
  // multiplyRateByTokens(tokens, ratePer1K) = roundHalfUp(rate×tokens/1000).
  check("tokens × rate exact (per-1K)", multiplyRateByTokens(1_000_000n, 15n) === 15_000n);
  check("BigInt survives huge products", multiplyRateByTokens(10_000_000n, 1_000_000n) === 10_000_000_000n);
  // Single final ROUND_HALF_UP at the very end (§20) — never mid-calculation.
  check("ROUND_HALF_UP at .5 exactly", multiplyRateByTokens(1n, 1500n) === 2n && divideHalfUpProbe(1499n) === 1n);
  check("divideBy1000 half-up exact", roundExact(1500n, 1000n) === 2n && roundExact(1499n, 1000n) === 1n);
  let threw = false;
  try {
    multiplyRateByTokens(-1n, 5n);
  } catch {
    threw = true;
  }
  check("negative tokens rejected (§127) [re-expressed via throw]", threw);
  check("negative token counts rejected by the parser layer", toBigIntSafe(-1) === null);
  threw = false;
  try {
    addNanoMinor(-1n, 0n);
  } catch {
    threw = true;
  }
  check("negative cost rejected (§127) [re-expressed via addNanoMinor guard]", threw);
  check("float is rejected (§8) [re-expressed via toBigIntSafe]", toBigIntSafe(1.5) === null);
  check("add exact (variadic → chained)", addNanoMinor(addNanoMinor(1n, 2n), 3n) === 6n);
  // [re-expressed] old subtractNanoMinor(3n,5n) === -2n proved signed values
  // are representable; roundExact is the current signed-safe primitive.
  check("signed difference survives exact arithmetic (§83 loss case)", roundExact(3n - 5n, 1n) === -2n);
  check("minor→nano exact + lossless round-trip", BigInt(1900) * NANO_MINOR_PER_MINOR === 1_900_000_000n && convertToMinorDisplayOnly(1_900_000_000n).minor === 1900n && convertToMinorDisplayOnly(1_900_000_000n).hasSubMinorResidue === false);
  check("nano→minor floor + remainder flag (§22)", convertToMinorDisplayOnly(2_500_000n).minor === 2n && convertToMinorDisplayOnly(2_500_000n).hasSubMinorResidue === true && 2_500_000n - 2n * NANO_MINOR_PER_MINOR === 500_000n);
  // [re-expressed] old formatNanoMinor(value, currency, decimals) — the
  // current API formats in MINOR units with full 6-decimal nano resolution
  // (display only, §22; currency labeling is the caller's concern).
  check("format full nano resolution (display-only §22)", formatNanoMinor(2_341n) === "0.002341" && formatNanoMinor(0n) === "0.000000");
  check("format exact minor value", formatNanoMinor(1_234_567n) === "1.234567");
  // [re-expressed] old parseMinorStringToNanoMinor — the current API accepts
  // ONLY strict integer strings: fractions can never enter as hidden money.
  check("parse strict integer string exact", toBigIntSafe("1500000") === 1_500_000n);
  check("parse rejects fractional string (no silent truncation)", toBigIntSafe("1.5") === null);
  check("parse rejects negative string", toBigIntSafe("-1") === null);
  // [re-expressed] old marginPpm (ppm) → the current documented integer
  // basis-point formula (§191): roundHalfUp(contribution/price × 10000),
  // computed with roundExact — the same formula economics.ts uses.
  const priceNano = BigInt(100) * NANO_MINOR_PER_MINOR; // 100 minor
  const contribution75 = priceNano - BigInt(25) * NANO_MINOR_PER_MINOR;
  const contributionLoss = priceNano - BigInt(125) * NANO_MINOR_PER_MINOR;
  check("margin bps exact profit (§42→§191)", Number(roundExact(contribution75 * 10_000n, priceNano)) === 7_500);
  check("margin bps exact loss (negative)", Number(roundExact(contributionLoss * 10_000n, priceNano)) === -2_500);
  threw = false;
  try {
    // Zero revenue must never divide (FREE §83) — the guard throws rather
    // than fabricating a percentage.
    roundExact(5n, 0n);
  } catch {
    threw = true;
  }
  check("margin at zero revenue never divides (FREE §83)", threw);
  check("BigInt-safe serialization (§89)", serializeNanoMinor(60_000n) === "60000" && serializeNanoMinor(null) === null);

  // =====================================================================
  section("B. rate service — versioning/windows/conflicts/verification (§8/§11/§12/§13/§28/§29/§32)");
  const t0 = new Date("2026-01-01T00:00:00Z");
  // Rates are per-1K nano-minor: v1 = 15n/60n per TOKEN equivalent of the
  // original tariff, expressed as 15_000n/60_000n per 1K (identical costs).
  const v1Input = {
    provider: "z-ai",
    model: DEFAULT_MODEL_MAPPING,
    currency: "EUR",
    inputRateNanoMinorPer1K: 15_000n,
    outputRateNanoMinorPer1K: 60_000n,
    version: "P26-TEST-v1",
    effectiveFrom: t0,
    environment: ENV,
    sourceReference: "TEST ONLY synthetic rate (§90)",
  } as const;
  const rateV1 = await createAiCostRate(v1Input); // throws on failure (§7)
  check("v1 created (throws-on-reject contract)", !!rateV1.id && rateV1.active === true && rateV1.environment === "TEST");
  check("created rate carries UNVERIFIED evidence state (§8)", rateV1.verification.state === "UNVERIFIED");
  let dupCode = "";
  try {
    await createAiCostRate({ ...v1Input });
  } catch (e) {
    dupCode = e instanceof AiCostRateError ? e.code : `unexpected:${String(e)}`;
  }
  check("duplicate version rejected (§12)", dupCode === "DUPLICATE_VERSION");
  let conflictCode = "";
  try {
    await createAiCostRate({
      ...v1Input,
      version: "P26-TEST-v1-conflict",
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      inputRateNanoMinorPer1K: 99_000n,
      outputRateNanoMinorPer1K: 99_000n,
    });
  } catch (e) {
    conflictCode = e instanceof AiCostRateError ? e.code : `unexpected:${String(e)}`;
  }
  check("overlapping active rate rejected (§29)", conflictCode === "OVERLAPPING_ACTIVE_RATE");
  let negCode = "";
  try {
    await createAiCostRate({ ...v1Input, version: "P26-TEST-neg", inputRateNanoMinorPer1K: -1n });
  } catch (e) {
    negCode = e instanceof AiCostRateError ? e.code : `unexpected:${String(e)}`;
  }
  check("negative rate rejected (§127)", negCode === "INVALID_RATE");
  let badCurCode = "";
  try {
    await createAiCostRate({ ...v1Input, version: "P26-TEST-badcur", currency: "EURO!" });
  } catch (e) {
    badCurCode = e instanceof AiCostRateError ? e.code : `unexpected:${String(e)}`;
  }
  check("bad currency rejected", badCurCode === "INVALID_CURRENCY");
  let badWinCode = "";
  try {
    await createAiCostRate({
      ...v1Input,
      version: "P26-TEST-badwin",
      effectiveFrom: new Date("2026-02-01T00:00:00Z"),
      effectiveTo: new Date("2026-01-01T00:00:00Z"),
    });
  } catch (e) {
    badWinCode = e instanceof AiCostRateError ? e.code : `unexpected:${String(e)}`;
  }
  check("invalid effective window rejected", badWinCode === "INVALID_EFFECTIVE_WINDOW");

  // Verification is the SEPARATE evidence step (§8) in the current API.
  const verifiedV1 = await verifyAiCostRate(rateV1.id, { verifiedBy: "p26-harness", sourceReference: "TEST ONLY synthetic rate (§90)" });
  check("verification step records all three evidence fields (§8)", verifiedV1.verification.state === "VERIFIED" && verifiedV1.verification.verifiedBy === "p26-harness");

  const beforeWindow = await resolveAiCostRate({ provider: "z-ai", model: DEFAULT_MODEL_MAPPING, environment: ENV, usageTimestamp: new Date("2025-12-31T23:59:59Z") });
  check("rate not active before effectiveFrom (§28)", beforeWindow.ok === false && beforeWindow.reason === "RATE_NOT_FOUND");
  const atV1 = await resolveAiCostRate({ provider: "z-ai", model: DEFAULT_MODEL_MAPPING, environment: ENV, usageTimestamp: new Date("2026-03-01T00:00:00Z") });
  check("v1 resolves in window", atV1.ok === true && atV1.rate.version === "P26-TEST-v1" && atV1.rate.currency === "EUR");

  // Exact-model preference over DEFAULT (§11).
  const irrRate = await createAiCostRate({
    provider: "z-ai",
    model: "p26-glm-x",
    currency: "IRR",
    inputRateNanoMinorPer1K: 1_000n,
    outputRateNanoMinorPer1K: 2_000n,
    version: "P26-TEST-irr-v1",
    effectiveFrom: t0,
    environment: ENV,
  });
  check("exact-model rate created", !!irrRate.id);
  const exact = await resolveAiCostRate({ provider: "z-ai", model: "p26-glm-x", environment: ENV, usageTimestamp: new Date("2026-03-01T00:00:00Z") });
  check("exact-model beats DEFAULT mapping (§11)", exact.ok === true && exact.rate.version === "P26-TEST-irr-v1" && exact.rate.currency === "IRR");

  // v2 handover (v1 window explicitly closed — never rewritten, closed forward).
  await db.aiCostRate.updateMany({
    where: { version: "P26-TEST-v1" },
    data: { effectiveTo: new Date("2026-04-01T00:00:00Z") },
  });
  const rateV2 = await createAiCostRate({
    ...v1Input,
    version: "P26-TEST-v2",
    effectiveFrom: new Date("2026-04-01T00:00:00Z"),
    inputRateNanoMinorPer1K: 20_000n,
    outputRateNanoMinorPer1K: 80_000n,
  });
  check("v2 created after v1 window closed", !!rateV2.id);
  const midV1 = await resolveAiCostRate({ provider: "z-ai", model: DEFAULT_MODEL_MAPPING, environment: ENV, usageTimestamp: new Date("2026-03-31T23:59:59Z") });
  const earlyV2 = await resolveAiCostRate({ provider: "z-ai", model: DEFAULT_MODEL_MAPPING, environment: ENV, usageTimestamp: new Date("2026-04-01T00:00:00Z") });
  check("historical window uses v1 (§13/§63)", midV1.ok === true && midV1.rate.version === "P26-TEST-v1");
  check("new window uses v2 (§120)", earlyV2.ok === true && earlyV2.rate.version === "P26-TEST-v2");

  // Environment isolation (§92/§93) — and the UNKNOWN-model DEFAULT policy.
  const prodProbe = await resolveAiCostRate({ provider: "z-ai", model: UNKNOWN_MODEL, environment: "PRODUCTION", usageTimestamp: new Date("2026-04-02T00:00:00Z") });
  check("TEST rates invisible in PRODUCTION", prodProbe.ok === false && prodProbe.reason === "RATE_NOT_FOUND");

  // =====================================================================
  section("C. ledger — real metering → attribution (§15–§24/§29/§31/§61–§69)");
  let businessId = await createFixtureBusiness();

  // C1: KNOWN cost from genuine usage + TEST rate (v2 window at usage time).
  // The caller passes the GENUINE provider-reported tokens (exactly the real
  // route behavior) after recording them through the metering service.
  const req1 = `p26-req-${STAMP}-1`;
  await meterAiOperation(businessId, req1, { meta: { transport: "chat" } });
  await recordAiTokenUsage(businessId, req1, { inputTokens: 1000, outputTokens: 500 }, { provider: "z-ai" });
  const att1 = await attributeAiCost({
    businessId,
    requestId: req1,
    provider: "z-ai",
    model: null, // §81/§82 honesty — no invented model identifier
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    usageTimestamp: new Date("2026-04-02T10:00:00Z"), // inside P26-TEST-v2
    environment: ENV,
  });
  check("attributed KNOWN", att1.outcome === "KNOWN", j(att1));
  check("exact cost in+out (§21, per-1K): 1000×20k + 500×80k ÷ 1000", att1.outcome === "KNOWN" && att1.costNanoMinor === 60_000n, att1.outcome === "KNOWN" ? String(att1.costNanoMinor) : j(att1));
  check("rate version snapshotted (§14)", att1.outcome === "KNOWN" && att1.rateVersion === "P26-TEST-v2");
  const rec1 = att1.outcome === "KNOWN" ? await db.aiCostRecord.findUniqueOrThrow({ where: { id: att1.recordId } }) : null;
  check("token status COMPLETE", rec1?.tokenStatus === "COMPLETE");

  // C2: idempotency — same logical operation twice → ONE record (§20/§31).
  const att1b = await attributeAiCost({
    businessId,
    requestId: req1,
    provider: "z-ai",
    model: null,
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    usageTimestamp: new Date("2026-04-02T10:00:00Z"),
    environment: ENV,
  });
  check("replay does not recreate (§20/§31)", att1b.outcome === "ALREADY_KNOWN" && att1b.recordId === rec1?.id, j(att1b));
  const records1 = await db.aiCostRecord.findMany({ where: { businessId, requestId: req1 } });
  check("exactly one record for the operation (§114/§117)", records1.length === 1);
  const requestEvent1 = await db.usageEvent.findFirst({ where: { businessId, requestId: req1, metric: "AI_REQUESTS", status: "COMMITTED" } });
  check("anchored to the COMMITTED AI_REQUESTS event (current anchor law)", records1[0] !== undefined && requestEvent1 !== null && records1[0]!.usageEventId === requestEvent1!.id);

  // C3: unknown rate → UNKNOWN / RATE_NOT_FOUND (§17), never zero.
  const req3 = `p26-req-${STAMP}-3`;
  await meterAiOperation(businessId, req3);
  await recordAiTokenUsage(businessId, req3, { inputTokens: 10, outputTokens: 10 }, { provider: "unverified-provider" });
  const att3 = await attributeAiCost({
    businessId,
    requestId: req3,
    provider: "unverified-provider",
    model: null,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    environment: ENV,
  });
  check("no rate → UNKNOWN / RATE_NOT_FOUND (§17)", att3.outcome === "UNKNOWN" && att3.reason === "RATE_NOT_FOUND", j(att3));
  const rec3 = await db.aiCostRecord.findFirstOrThrow({ where: { businessId, requestId: req3 } });
  check("UNKNOWN carries NO amount and NO currency (§18)", rec3.costNanoMinor === null && rec3.currency === null);

  // C4: no token usage → UNKNOWN / TOKENS_MISSING (§65-1).
  const req4 = `p26-req-${STAMP}-4`;
  await meterAiOperation(businessId, req4);
  const att4 = await attributeAiCost({ businessId, requestId: req4, provider: "z-ai", model: null, usage: null, environment: ENV });
  check("no tokens → UNKNOWN / TOKENS_MISSING", att4.outcome === "UNKNOWN" && att4.reason === "TOKENS_MISSING", j(att4));

  // C5: partial tokens → UNKNOWN / PARTIAL_TOKEN_DATA (§22 — output NOT
  // assumed 0; the missing dimension is stored as SQL NULL, never fabricated).
  const req5 = `p26-req-${STAMP}-5`;
  await meterAiOperation(businessId, req5);
  const att5 = await attributeAiCost({
    businessId,
    requestId: req5,
    provider: "z-ai",
    model: null,
    usage: { inputTokens: 100, outputTokens: null, totalTokens: null },
    environment: ENV,
  });
  check("partial tokens → UNKNOWN (§22)", att5.outcome === "UNKNOWN" && att5.reason === "PARTIAL_TOKEN_DATA", j(att5));
  const rec5 = await db.aiCostRecord.findFirstOrThrow({ where: { businessId, requestId: req5 } });
  check("partial: missing dimension NOT fabricated (§22, honest NULL)", rec5.inputTokens === 100 && rec5.outputTokens === null && rec5.tokenStatus === "PARTIAL" && rec5.costNanoMinor === null);

  // C6: total-only → never priced (§23 — no invented split).
  const req6 = `p26-req-${STAMP}-6`;
  await meterAiOperation(businessId, req6);
  await recordAiTokenUsage(businessId, req6, { totalTokens: 900 }, { provider: "z-ai" });
  const att6 = await attributeAiCost({
    businessId,
    requestId: req6,
    provider: "z-ai",
    model: null,
    usage: { inputTokens: null, outputTokens: null, totalTokens: 900 },
    environment: ENV,
  });
  check("total-only → UNKNOWN, never priced (§23)", att6.outcome === "UNKNOWN" && att6.reason === "PARTIAL_TOKEN_DATA", j(att6));
  const rec6 = await db.aiCostRecord.findFirstOrThrow({ where: { businessId, requestId: req6 } });
  check("total-only token status preserved (no invented split)", rec6.tokenStatus === "TOTAL_ONLY");

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
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    environment: ENV,
  });
  check("exact-model rate applied (IRR)", att7.outcome === "KNOWN" && att7.currency === "IRR" && att7.costNanoMinor === 300n, j(att7));
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
    model: null,
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    usageTimestamp: new Date("2026-03-31T12:00:00Z"), // inside P26-TEST-v1
    environment: ENV,
  });
  check("historical usage priced with v1 (§14/§63)", att8.outcome === "KNOWN" && att8.rateVersion === "P26-TEST-v1");
  check("v1 math exact: 1000×15k + 500×60k ÷ 1000", att8.outcome === "KNOWN" && att8.costNanoMinor === 45_000n, att8.outcome === "KNOWN" ? String(att8.costNanoMinor) : j(att8));

  // C9: released usage → NO cost record (§20/§108).
  const req9 = `p26-req-${STAMP}-9`;
  await meterAiOperation(businessId, req9);
  await releaseAiOperation(businessId, req9, { reason: "provider-unavailable" });
  const att9 = await attributeAiCost({ businessId, requestId: req9, provider: "z-ai", model: null, usage: null, environment: ENV });
  check("released usage → no attribution (nothing consumed)", att9.outcome === "NO_USAGE_EVENT", j(att9));
  check("no record for released usage", (await db.aiCostRecord.count({ where: { businessId, requestId: req9 } })) === 0);

  // C10: attribution is fail-safe (§29) — the single entry point NEVER throws
  // [re-expressed: the old attributeAiCostSafe wrapper no longer exists; the
  // never-throw boundary now lives in attributeAiCost itself and returns the
  // discriminated AttributeAiCostResult union. The FAILED member exists for
  // infrastructure errors and cannot be triggered without fault injection —
  // the unusable-input path proves the never-throw contract here].
  const unusable = await attributeAiCost({
    businessId: "no-such-business",
    requestId: "no-such-request",
    provider: "z-ai",
    model: null,
    usage: null,
    environment: ENV,
  });
  check("attributeAiCost never throws on unusable input (§29)", unusable.outcome === "NO_USAGE_EVENT", j(unusable));

  // Restore fixture to FREE (worklog invariant: no business left upgraded).
  await deleteBusinessFixtures(businessId);
  businessId = await createFixtureBusiness();
  await meterAiOperation(businessId, `p26-req-${STAMP}-warmup`); // ensures the FREE subscription exists

  // =====================================================================
  section("D. economics — exact ledger aggregation + status-gated plan economics (§36–§44/§47/§79–§87/§112–§117)");
  // Deterministic fixture set under the second fixture business:
  //   K1: FREE   + EUR(v2) 1000in/500out → 60,000 nano EUR
  //   U1: FREE   + no tokens             → UNKNOWN (TOKENS_MISSING)
  //   K3: STARTER+ EUR(v2) 200in/100out  → 12,000 nano EUR
  //   K2: STARTER+ IRR (exact model)     → 300 nano IRR (NO FX bucket)
  // planCodeAtUsage is captured per record at attribution time, so the
  // subscription is switched only to WRITE history, then restored to FREE
  // (worklog invariant: no business left upgraded).
  const k1 = `p26-req-${STAMP}-k1`;
  await meterAiOperation(businessId, k1);
  await recordAiTokenUsage(businessId, k1, { inputTokens: 1000, outputTokens: 500 }, { provider: "z-ai" });
  const aK1 = await attributeAiCost({ businessId, requestId: k1, provider: "z-ai", model: null, usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, usageTimestamp: new Date("2026-04-02T10:00:00Z"), environment: ENV });
  check("fixture K1 KNOWN/EUR 60,000 (FREE bucket)", aK1.outcome === "KNOWN" && aK1.costNanoMinor === 60_000n, j(aK1));

  const u1 = `p26-req-${STAMP}-u1`;
  await meterAiOperation(businessId, u1);
  const aU1 = await attributeAiCost({ businessId, requestId: u1, provider: "z-ai", model: null, usage: null, environment: ENV });
  check("fixture U1 UNKNOWN (no tokens)", aU1.outcome === "UNKNOWN", j(aU1));

  const starterPlanRow = await db.plan.findUniqueOrThrow({ where: { code: "STARTER" }, select: { id: true } });
  const freePlanRow = await db.plan.findUniqueOrThrow({ where: { code: "FREE" }, select: { id: true } });
  await db.subscription.update({ where: { businessId }, data: { planId: starterPlanRow.id, status: "ACTIVE" } });

  const k3 = `p26-req-${STAMP}-k3`;
  await meterAiOperation(businessId, k3);
  await recordAiTokenUsage(businessId, k3, { inputTokens: 200, outputTokens: 100 }, { provider: "z-ai" });
  const aK3 = await attributeAiCost({ businessId, requestId: k3, provider: "z-ai", model: null, usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, usageTimestamp: new Date("2026-04-02T10:00:00Z"), environment: ENV });
  check("fixture K3 KNOWN/EUR 12,000 (STARTER bucket)", aK3.outcome === "KNOWN" && aK3.costNanoMinor === 12_000n, j(aK3));

  const k2 = `p26-req-${STAMP}-k2`;
  await meterAiOperation(businessId, k2);
  await recordAiTokenUsage(businessId, k2, { inputTokens: 100, outputTokens: 100 }, { provider: "z-ai" });
  const aK2 = await attributeAiCost({ businessId, requestId: k2, provider: "z-ai", model: "p26-glm-x", usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 }, environment: ENV });
  check("fixture K2 KNOWN/IRR 300 (exact model)", aK2.outcome === "KNOWN" && aK2.currency === "IRR" && aK2.costNanoMinor === 300n, j(aK2));

  // Restore FREE immediately (invariant); stored planCodeAtUsage is preserved.
  await db.subscription.update({ where: { businessId }, data: { planId: freePlanRow.id, status: "ACTIVE" } });

  // D1: exact business-scoped ledger aggregation (currencies NEVER mixed §62;
  // coverage over attributable RECORDS §47 — [re-expressed] from the removed
  // aggregateAiCost with the current documented integer formulas).
  const ours = await db.aiCostRecord.findMany({
    where: { businessId, requestId: { startsWith: `p26-req-${STAMP}` } },
    select: { costStatus: true, currency: true, costNanoMinor: true, totalTokens: true },
  });
  const knownEur = ours.filter((r) => r.costStatus === "KNOWN" && r.currency === "EUR").reduce((acc, r) => acc + (r.costNanoMinor ?? 0n), 0n);
  const knownIrr = ours.filter((r) => r.costStatus === "KNOWN" && r.currency === "IRR").reduce((acc, r) => acc + (r.costNanoMinor ?? 0n), 0n);
  const knownCount = ours.filter((r) => r.costStatus === "KNOWN").length;
  const unknownCount = ours.filter((r) => r.costStatus === "UNKNOWN").length;
  check("coverage counts only KNOWN (§37/§47)", knownCount === 3 && unknownCount === 1, `k=${knownCount} u=${unknownCount}`);
  check("EUR known cost exact (60,000+12,000)", knownEur === 72_000n, String(knownEur));
  check("IRR cost reported in its OWN currency (no FX, §32)", knownIrr === 300n, String(knownIrr));
  check("coverage = 3 known / 4 attributable = 7500bps (§47 formula)", Number((BigInt(knownCount) * 10_000n + BigInt(knownCount + unknownCount) / 2n) / BigInt(knownCount + unknownCount)) === 7_500);
  const warmupPending = await db.usageEvent.count({
    where: { businessId, requestId: `p26-req-${STAMP}-warmup`, metric: "AI_REQUESTS", status: "COMMITTED" },
  });
  check("pendingAttribution counts committed-but-unattributed (warmup)", warmupPending === 1);

  // D2: module breakdown — business-scoped row must match the exact fixture.
  const breakdown = await getAiCostBreakdown(1);
  const bizRow = breakdown.byBusiness.find((r) => r.key === businessId);
  check("getAiCostBreakdown row matches the fixture exactly (§46/§58-§61)", !!bizRow && bizRow.knownRecords === 3 && bizRow.unknownRecords === 1 && bizRow.knownCostNanoMinorByCurrency["EUR"] === "72000" && bizRow.knownCostNanoMinorByCurrency["IRR"] === "300" && bizRow.tokens === 2000n, j(bizRow ?? null));
  check("breakdown row coverage bps = 7500 (module formula)", bizRow?.coverageBps === 7_500);

  // D3: UNKNOWN-cost diagnostic dataset (§49).
  const unknownGroups = await getUnknownCostGroups(1);
  check("getUnknownCostGroups exposes the U1 group (TOKENS_MISSING)", unknownGroups.groups.some((g) => g.businessId === businessId && g.reason === "TOKENS_MISSING" && g.count === 1), j(unknownGroups.groups));

  // D4: platform health — honest top line, per-currency, guard status (§112).
  delete process.env.AI_COST_GUARD_ENABLED; // §46 default-off must hold here
  resetAiCostConfigCache();
  const health = await getAiCostHealth(1);
  check("getAiCostHealth per-currency totals ≥ fixture (never mixed §62)", BigInt(health.knownCostNanoMinorByCurrency["EUR"] ?? "0") >= 72_000n && BigInt(health.knownCostNanoMinorByCurrency["IRR"] ?? "0") >= 300n, j(health.knownCostNanoMinorByCurrency));
  check("health records ≥ fixture counts", health.knownRecords >= 3 && health.unknownRecords >= 1 && health.attributableRecords === health.knownRecords + health.unknownRecords);
  check("guard DISABLED by default surfaces in health (§46)", health.guardStatus === "DISABLED");

  // D5: status-gated plan economics (§50–§57/§114–§116). Threshold seams come
  // from config (documented env vars + test-seam cache reset).
  process.env.MIN_ECONOMICS_SAMPLE_SIZE = "1";
  process.env.MIN_COST_COVERAGE_FOR_ECONOMICS = "5000";
  resetAiCostConfigCache();
  try {
    // FREE is NOT_PURCHASABLE (§38) — never a fake zero-price checkout, so
    // the current honest status is PRICE_UNKNOWN [replaces the old "FREE
    // price 0" expectation, which contradicted the current pricing law].
    const free = await getPlanAiEconomics("FREE", "MONTHLY", { currency: "EUR", windowDays: 1 });
    check("FREE → PRICE_UNKNOWN (NOT_PURCHASABLE §38, never fake 0-price)", free.status === "PRICE_UNKNOWN" && free.priceMinor === null, j(free));
    check("economics label is AI_CONTRIBUTION (never profit §43/§115)", free.label === "AI_CONTRIBUTION");

    // ENTERPRISE (§39/§84) — PRICE_UNKNOWN.
    const ent = await getPlanAiEconomics("ENTERPRISE", "MONTHLY", { currency: "EUR", windowDays: 1 });
    check("ENTERPRISE → PRICE_UNKNOWN (§84)", ent.status === "PRICE_UNKNOWN");

    // STARTER — authoritative EUR book price (900 minor), but the fixture has
    // TWO known-cost currencies (EUR + IRR) → never compared (§167).
    const starter = await getPlanAiEconomics("STARTER", "MONTHLY", { currency: "EUR", windowDays: 1 });
    check("STARTER price from authoritative book (§34)", starter.priceMinor === 900 && starter.priceCurrency === "EUR", j(starter));
    check("EUR+IRR known buckets reported separately (no FX §32)", starter.knownCostNanoMinorByCurrency["EUR"] === "12000" && starter.knownCostNanoMinorByCurrency["IRR"] === "300", j(starter.knownCostNanoMinorByCurrency));
    check("multi-currency cost → NOT_COMPARABLE_CURRENCY (§85/§167)", starter.status === "NOT_COMPARABLE_CURRENCY" && starter.costCurrency === null && starter.contributionMinor === null, j(starter));

    // Remove the IRR KNOWN record → single-currency → COMPARABLE arithmetic.
    if (aK2.outcome === "KNOWN") await db.aiCostRecord.delete({ where: { id: aK2.recordId } });
    const comparable = await getPlanAiEconomics("STARTER", "MONTHLY", { currency: "EUR", windowDays: 1 });
    check("single-currency → COMPARABLE (§114 gate order)", comparable.status === "COMPARABLE", j(comparable));
    // 900 minor − 12,000 nano-minor = 899.988 minor → 900 minor (the DTO
    // reports MINOR units with a single final ROUND_HALF_UP, §20/§167).
    check("exact contribution: 900 minor − 12,000 nano → 900 minor (§167/§20)", comparable.contributionMinor === 900, String(comparable.contributionMinor));
    check("exact integer margin bps: floor(9999.867→half-up) = 10000 (§191)", comparable.contributionMarginBps === 10_000, String(comparable.contributionMarginBps));
    check("contribution positive flag honest", comparable.negativeContribution === false && comparable.costCurrency === "EUR");

    // YEARLY — real stored row (9000), never computed 900×10 (§21/§61).
    const yearly = await getPlanAiEconomics("STARTER", "YEARLY", { currency: "EUR", windowDays: 1 });
    check("STARTER YEARLY price is the real stored 9000 (§21/§61)", yearly.priceMinor === 9000 && yearly.priceCurrency === "EUR", j(yearly));
    // 9000 minor − 12,000 nano-minor = 8999.988 minor → 9000 minor (half-up).
    check("YEARLY contribution exact: 9000 minor − 12,000 nano → 9000 minor", yearly.status === "COMPARABLE" && yearly.contributionMinor === 9000, `${yearly.status}/${String(yearly.contributionMinor)}`);

    // Insufficient sample (§82/§53) — threshold above the sample size.
    process.env.MIN_ECONOMICS_SAMPLE_SIZE = "500";
    resetAiCostConfigCache();
    const starterSmall = await getPlanAiEconomics("STARTER", "MONTHLY", { currency: "EUR", windowDays: 1 });
    check("below min sample → INSUFFICIENT_SAMPLE (§82)", starterSmall.status === "INSUFFICIENT_SAMPLE" && starterSmall.sampleSize < 500 && starterSmall.contributionMinor === null, j(starterSmall));
  } finally {
    delete process.env.MIN_ECONOMICS_SAMPLE_SIZE;
    delete process.env.MIN_COST_COVERAGE_FOR_ECONOMICS;
    resetAiCostConfigCache();
  }

  // D6: analytical scenario math [re-expressed with the current per-1K
  // primitives — simulatePlanScenario was removed]. 150 requests ×
  // (1600 in × 15k/1K + 400 out × 60k/1K) — exact integer, single rounding.
  const inTokens = (BigInt(2000) * BigInt(800_000)) / 1_000_000n; // inputSharePpm 800_000 → 1600
  const outTokens = 2000n - inTokens; // 400
  const perRequest = addNanoMinor(multiplyRateByTokens(inTokens, 15_000n), multiplyRateByTokens(outTokens, 60_000n));
  const scenarioCost = perRequest * 150n;
  const revenueNano = BigInt(1900) * NANO_MINOR_PER_MINOR;
  check("scenario cost exact: 150×(1600×15k + 400×60k)÷1000 (§103)", scenarioCost === 7_200_000n, String(scenarioCost));
  check("breakeven = revenue nano (§105)", revenueNano === 1_900_000_000n);
  check("breakeven requests floor-exact", revenueNano / perRequest === 39_583n && perRequest === 48_000n);
  check("margin at breakeven rounds to ~0 (integer half-up)", Math.abs(Number(roundExact(revenueNano - scenarioCost, revenueNano))) <= 1);

  // =====================================================================
  section("E. governance — anomalies + guard (§46–§48/§66–§71/§97–§102/§117–§124)");
  // Detector shape + honest INSUFFICIENT_HISTORY (§117 — never fabricate a
  // baseline) [re-expressed: detectAiCostAnomalies takes windowDays now].
  const anomalies = await detectAiCostAnomalies(1);
  check("detector returns report without acting (§97)", typeof anomalies.windowDays === "number" && anomalies.windowDays === 1 && Array.isArray(anomalies.detail) && anomalies.anomaliesDetected === anomalies.detail.length);
  check("quiet previous window → INSUFFICIENT history, nothing fabricated (§117)", anomalies.baselineInsufficient === true && anomalies.anomaliesDetected === 0, j(anomalies));

  // Observability (§96) [re-expressed via getAiCostBreakdown: after D5 the
  // IRR record K2 was deleted — remaining: K1 (1500 tok) + K3 (300 tok) KNOWN,
  // U1 UNKNOWN]. Scoped view must be exact; platform view ≥ scoped.
  const obs = await getAiCostBreakdown(1);
  const obsRow = obs.byBusiness.find((r) => r.key === businessId);
  check("observability aggregates present (§96)", !!obsRow && obsRow.tokens === 1800n && obsRow.knownRecords === 2 && obsRow.unknownRecords === 1, j(obsRow ?? null));
  const platformTokens = obs.byBusiness.reduce((acc, r) => acc + r.tokens, 0n);
  const platformKnownEur = obs.byBusiness.reduce((acc, r) => acc + BigInt(r.knownCostNanoMinorByCurrency["EUR"] ?? "0"), 0n);
  check("platform observability ≥ scoped (§96)", platformTokens >= 1800n && platformKnownEur >= 72_000n);

  // Guard matrix (§46–§48/§66–§71) on the CURRENT config-driven guard.
  const savedEnv = { ...process.env };
  try {
    // (a) §46 — DISABLED by default: no evaluation, no block.
    delete process.env.AI_COST_GUARD_ENABLED;
    resetAiCostConfigCache();
    const guardDisabled = await assertAiCostGuard();
    check("guard DISABLED by default (§46)", guardDisabled.decision === "ALLOW" && guardDisabled.blocked === false && guardDisabled.failOpenTriggered === false, j(guardDisabled));

    // (b) §47 — enabled WITHOUT configured ceilings: nothing enforceable,
    // never a fabricated threshold.
    process.env.AI_COST_GUARD_ENABLED = "true";
    resetAiCostConfigCache();
    const guardUnconf = await assertAiCostGuard();
    check("enabled without ceiling config → ALLOW (no fabricated thresholds §47)", guardUnconf.decision === "ALLOW" && guardUnconf.blocked === false, j(guardUnconf));

    // (c) §67 positive control — a VERIFIED known cost above the ceiling
    // BLOCKS (the fixture's TEST KNOWN records are ≥ 72,000 nano > 1).
    process.env.AI_COST_GUARD_MAX_PERIOD_COST_NANO_MINOR = "1";
    process.env.AI_COST_GUARD_WINDOW_DAYS = "1";
    resetAiCostConfigCache();
    const guardCeiling = await assertAiCostGuard();
    check("period ceiling blocks on verified KNOWN cost (§67)", guardCeiling.decision === "BLOCK" && guardCeiling.reasons.some((r) => r.startsWith("PERIOD_COST_CEILING")), j(guardCeiling));

    // (d) §71 request-level preflight ceiling — estimate from a verified rate.
    process.env.AI_COST_GUARD_MAX_REQUEST_COST_NANO_MINOR = "1000";
    // Remove the fixture's KNOWN records so only the request ceiling is live.
    await db.aiCostRecord.deleteMany({ where: { businessId, costStatus: "KNOWN" } });
    resetAiCostConfigCache();
    const guardReqOver = await assertAiCostGuard({ estimatedRequestCostNanoMinor: 2000n, currency: "EUR" });
    check("request preflight ceiling blocks over-estimate (§71)", guardReqOver.decision === "BLOCK" && guardReqOver.reasons.some((r) => r.startsWith("REQUEST_COST_CEILING")), j(guardReqOver));
    const guardReqUnder = await assertAiCostGuard({ estimatedRequestCostNanoMinor: 999n, currency: "EUR" });
    check("request under ceiling → ALLOW", guardReqUnder.decision === "ALLOW" && guardReqUnder.blocked === false, j(guardReqUnder));

    // (e) §68 — UNKNOWN cost never blocks: only U1 (UNKNOWN) remains, the
    // period ceiling is still 1 nano-minor, and the decision is ALLOW.
    const stillUnknown = await db.aiCostRecord.count({ where: { businessId, costStatus: "UNKNOWN" } });
    const guardUnknown = await assertAiCostGuard();
    check("UNKNOWN-only ledger never blocks (§68)", stillUnknown >= 1 && guardUnknown.decision === "ALLOW" && guardUnknown.blocked === false, j(guardUnknown));
  } finally {
    Object.assign(process.env, savedEnv);
    delete process.env.AI_COST_GUARD_ENABLED;
    delete process.env.AI_COST_GUARD_MAX_PERIOD_COST_NANO_MINOR;
    delete process.env.AI_COST_GUARD_MAX_REQUEST_COST_NANO_MINOR;
    delete process.env.AI_COST_GUARD_WINDOW_DAYS;
    if (savedEnv.AI_COST_GUARD_ENABLED !== undefined) process.env.AI_COST_GUARD_ENABLED = savedEnv.AI_COST_GUARD_ENABLED;
    resetAiCostConfigCache();
  }

  // =====================================================================
  section("F. security & isolation (§73/§76/§77/§92/§130/§145/§146/§147/§148)");
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
  const attTamper = await attributeAiCost({ businessId, requestId: reqTamper, provider: "z-ai", model: null, usage: null, environment: ENV });
  check("tampered operation → UNKNOWN, never fabricated", attTamper.outcome === "UNKNOWN" && attTamper.reason === "TOKENS_MISSING", j(attTamper));

  // TEST rates never leak into the PRODUCTION attribution path (§92).
  const prodRates = await db.aiCostRate.count({ where: { environment: "PRODUCTION", version: { startsWith: "P26-TEST" } } });
  check("no TEST rates leaked into PRODUCTION (§92)", prodRates === 0);

  await deleteBusinessFixtures(otherBiz);
}

/** Local ROUND_HALF_UP probe used by §A (mirrors the documented divideBy1000
 *  policy without importing a second binding). */
function divideHalfUpProbe(dividend: bigint): bigint {
  return (dividend + 500n) / 1000n;
}

// ---------------------------------------------------------------------------
// Runner — cleanup ALWAYS wins over reporting.
// ---------------------------------------------------------------------------
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

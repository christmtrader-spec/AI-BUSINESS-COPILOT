/**
 * scripts/r135-usage-series.ts — R135 harness.
 *
 * The daily AI-usage series behind the ⌘K quick dialog's sparkline:
 *
 *   [A] clampSeriesDays — zero-trust `?days=` (fallback, never an echo of
 *       a hostile value; [1,30] hard bound).
 *   [B] seriesWindowKeys + utcDayKey — UTC day math (month/year
 *       boundaries, days=1, ordering oldest→newest).
 *   [C] buildUsageSeries (PURE) — zero-fill honesty (an absent day is a
 *       zero, never a gap), per-day summing, malformed/future/pre-window
 *       rows dropped WHOLESALE, negative/fractional quantities rejected,
 *       from/to/days coherent.
 *   [D] LIVE HTTP (dev:3000) as the r131-qa persona — the REAL meter
 *       (meterAiOperation) writes COMMITTED rows; the series must count
 *       them, the RELEASED row must vanish from the counts, ?days clamps
 *       server-side, the endpoint is session-gated, and the business is
 *       resolved server-side (a foreign x-business-id can never leak
 *       another tenant's usage — §55/§99).
 *
 * Run: bun scripts/r135-usage-series.ts
 *   (Part D needs dev:3000 UP + R135_QA_EMAIL / R135_QA_PW / R135_QA_BID
 *    — seed via scripts/r131-qa-seed.mjs, sweep-registered personas only.)
 */

import {
  buildUsageSeries,
  clampSeriesDays,
  seriesWindowKeys,
  utcDayKey,
  USAGE_SERIES_MAX_DAYS,
  USAGE_SERIES_DEFAULT_DAYS,
} from "../src/lib/billing/usage-series";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    failures.push(name);
  }
}

// ---- A  clampSeriesDays -------------------------------------------------------
console.log("A  clampSeriesDays (zero-trust ?days=)");
{
  ok("A1 default when null", clampSeriesDays(null) === USAGE_SERIES_DEFAULT_DAYS);
  ok("A2 default when undefined", clampSeriesDays(undefined) === USAGE_SERIES_DEFAULT_DAYS);
  ok("A3 default when garbage", clampSeriesDays("abc") === USAGE_SERIES_DEFAULT_DAYS);
  ok("A4 default when empty string", clampSeriesDays("") === USAGE_SERIES_DEFAULT_DAYS);
  ok("A5 default when float", clampSeriesDays("12.5") === USAGE_SERIES_DEFAULT_DAYS);
  ok("A6 default when 0", clampSeriesDays("0") === USAGE_SERIES_DEFAULT_DAYS);
  ok("A7 default when negative", clampSeriesDays("-3") === USAGE_SERIES_DEFAULT_DAYS);
  ok("A8 default when above max", clampSeriesDays(String(USAGE_SERIES_MAX_DAYS + 1)) === USAGE_SERIES_DEFAULT_DAYS);
  ok("A9 default when 999 (hostile echo guard)", clampSeriesDays("999") === USAGE_SERIES_DEFAULT_DAYS);
  ok("A10 1 passes", clampSeriesDays("1") === 1);
  ok("A11 14 passes", clampSeriesDays("14") === 14);
  ok("A12 30 (the max) passes", clampSeriesDays("30") === USAGE_SERIES_MAX_DAYS);
  ok("A13 number input 7 passes", clampSeriesDays(7) === 7);
  ok("A14 NaN number falls back", clampSeriesDays(Number.NaN) === USAGE_SERIES_DEFAULT_DAYS);
}

// ---- B  window keys ------------------------------------------------------------
console.log("\nB  seriesWindowKeys + utcDayKey (UTC day math)");
{
  const wed = new Date("2026-10-28T06:33:00.000Z"); // mid-day UTC
  ok("B1 utcDayKey truncates to YYYY-MM-DD", utcDayKey(wed) === "2026-10-28");
  ok("B2 utcDayKey uses UTC (not local) — 23:30 UTC stays the same day", utcDayKey(new Date("2026-10-28T23:30:00.000Z")) === "2026-10-28");

  const w14 = seriesWindowKeys(wed, 14);
  ok("B3 length is exactly days", w14.length === 14);
  ok("B4 newest key is today", w14[w14.length - 1] === "2026-10-28");
  ok("B5 oldest key is today-(days-1)", w14[0] === "2026-10-15");
  ok("B6 ordering oldest→newest", w14.every((k, i) => i === 0 || k > w14[i - 1]));

  const monthEdge = seriesWindowKeys(new Date("2026-03-05T12:00:00.000Z"), 7);
  ok("B7 month boundary honest", monthEdge[0] === "2026-02-27" && monthEdge[6] === "2026-03-05");
  const yearEdge = seriesWindowKeys(new Date("2027-01-02T12:00:00.000Z"), 5);
  ok("B8 year boundary honest", yearEdge[0] === "2026-12-29" && yearEdge[4] === "2027-01-02");
  const leapEdge = seriesWindowKeys(new Date("2028-03-01T12:00:00.000Z"), 3);
  ok("B9 leap February honest", leapEdge[0] === "2028-02-28" && leapEdge[1] === "2028-02-29");

  const w1 = seriesWindowKeys(wed, 1);
  ok("B10 days=1 is exactly [today]", w1.length === 1 && w1[0] === "2026-10-28");
}

// ---- C  buildUsageSeries (pure) --------------------------------------------------
console.log("\nC  buildUsageSeries (zero-fill + drop laws)");
{
  const today = new Date("2026-10-28T09:00:00.000Z");

  const empty = buildUsageSeries([], today, 14);
  ok("C1 zero-fill: every day present", empty.series.length === 14);
  ok("C2 zero-fill: all zeros", empty.series.every((d) => d.requests === 0));
  ok("C3 window from/to coherent", empty.from === "2026-10-15" && empty.to === "2026-10-28");
  ok("C4 days mirrors series length", empty.days === empty.series.length);

  const merged = buildUsageSeries(
    [
      { day: "2026-10-27", requests: 3 },
      { day: "2026-10-27", requests: 2 },
      { day: "2026-10-28", requests: 5 },
    ],
    today,
    14,
  );
  const d27 = merged.series.find((d) => d.date === "2026-10-27");
  const d28 = merged.series.find((d) => d.date === "2026-10-28");
  ok("C5 same-day rows SUM", d27?.requests === 5, String(d27?.requests));
  ok("C6 distinct days keep their own sums", d28?.requests === 5, String(d28?.requests));

  const drops = buildUsageSeries(
    [
      { day: "not-a-date", requests: 9 },
      { day: "2026-10-290", requests: 9 },
      { day: "2026-10-29", requests: 9 }, // future (clock skew)
      { day: "2026-10-10", requests: 9 }, // pre-window
      { day: "2026-10-26", requests: -4 }, // negative
      { day: "2026-10-26", requests: Number.NaN }, // non-finite
      { day: "2026-10-25", requests: 2.9 }, // fractional
    ],
    today,
    14,
  );
  ok("C7 malformed keys dropped wholesale", drops.series.every((d) => d.requests === 0 || d.date === "2026-10-25"));
  ok("C8 future-dated row dropped", !drops.series.some((d) => d.date === "2026-10-29"));
  ok("C9 pre-window row dropped", !drops.series.some((d) => d.date === "2026-10-10"));
  ok("C10 negative row dropped", !(drops.series.find((d) => d.date === "2026-10-26")?.requests === -4));
  ok("C11 fractional floored", drops.series.find((d) => d.date === "2026-10-25")?.requests === 2);
  ok("C12 window length unchanged by drops", drops.series.length === 14);

  const maxWin = buildUsageSeries([{ day: "2020-01-01", requests: 1 }], new Date("2026-10-28T09:00:00.000Z"), USAGE_SERIES_MAX_DAYS);
  ok("C13 max window shape", maxWin.series.length === USAGE_SERIES_MAX_DAYS && maxWin.from === "2026-09-29");
}

console.log(`\n== [pure] r135: ${passed} passed, ${failed} failed ==`);

// ---- D  LIVE HTTP ----------------------------------------------------------------
console.log("\n== [D] live HTTP (dev:3000) ==");

const BASE = "http://localhost:3000";
const EMAIL = process.env.R135_QA_EMAIL ?? "";
const PW = process.env.R135_QA_PW ?? "";
const BID = process.env.R135_QA_BID ?? "";

function mkJar() {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit = {}, bizId?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bizId) headers["x-business-id"] = bizId;
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const raw = res.headers.get("set-cookie");
    if (raw) for (const piece of raw.split(/,(?=[^;]+=)/)) {
      const [pair] = piece.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  };
}

if (EMAIL && PW && BID) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  // Fixture law (the r63/privacy-deletion pattern): the REAL meter is not
  // importable from a script (server-only boundary — added after prompt21's
  // "no server-only boundaries" note went stale), so part D writes the
  // exact rows a metered operation writes — a COMMITTED AI_REQUESTS
  // UsageEvent — directly, and part D7/D8 prove the series reads THAT
  // population (RELEASED exclusion included by status-flipping the row).
  async function ensurePeriod(bizId: string): Promise<string> {
    const existing = await prisma.usagePeriod.findFirst({ where: { businessId: bizId }, orderBy: { start: "desc" } });
    if (existing) return existing.id;
    const created = await prisma.usagePeriod.create({
      data: { businessId: bizId, start: new Date(Date.UTC(2026, 0, 1)), end: new Date(Date.UTC(2026, 11, 31)) },
    });
    return created.id;
  }
  async function meterRows(bizId: string, rid: string, qty: number): Promise<void> {
    const periodId = await ensurePeriod(bizId);
    await prisma.usageEvent.create({
      data: { businessId: bizId, usagePeriodId: periodId, metric: "AI_REQUESTS", quantity: qty, status: "COMMITTED", requestId: rid, idempotencyKey: `${rid}:AI_REQUESTS` },
    });
  }

  const f = mkJar();
  const csrf = (await (await f("/api/auth/csrf")).json()) as { csrfToken: string };
  const login = await f("/api/auth/callback/credentials", {
    method: "POST",
    body: JSON.stringify({ csrfToken: csrf.csrfToken, email: EMAIL, password: PW, redirect: false }),
  });
  ok("D1 persona login", login.status < 400, String(login.status));

  // Session gate: the SAME fetch without the cookie jar must be 401.
  const anon = await fetch(`${BASE}/api/v1/billing/usage/series?days=14`);
  ok("D2 anonymous series is 401", anon.status === 401, String(anon.status));

  // Baseline read.
  const read = async (days: number | string) =>
    (await (await f(`/api/v1/billing/usage/series?days=${days}`, {}, BID)).json()) as {
      data?: { window?: { from: string; to: string }; days?: number; series?: Array<{ date: string; requests: number }> };
    };
  const base = await read(14);
  const baseSeries = base.data?.series ?? [];
  const todayKey = utcDayKey(new Date());
  const baseToday = baseSeries.find((d) => d.date === todayKey)?.requests ?? -1;
  ok("D3 series shape: days=14, length=14", base.data?.days === 14 && baseSeries.length === 14, JSON.stringify({ days: base.data?.days, len: baseSeries.length }));
  ok("D4 window ends today (UTC)", base.data?.window?.to === todayKey, base.data?.window?.to ?? "?");
  ok("D5 zero-filled + ordered", baseSeries.every((d, i) => i === 0 || d.date > baseSeries[i - 1].date) && baseSeries.every((d) => Number.isInteger(d.requests) && d.requests >= 0));
  ok("D6 today readable from the baseline", baseToday >= 0, String(baseToday));

  // The meter's exact write shape (fixture) lands; the series must see it
  // (ONE population law).
  const rid1 = crypto.randomUUID();
  const rid2 = crypto.randomUUID();
  await meterRows(BID, rid1, 1);
  await meterRows(BID, rid2, 1);
  const afterMeter = await read(14);
  const afterToday = afterMeter.data?.series?.find((d) => d.date === todayKey)?.requests ?? -1;
  ok("D7 two COMMITTED AI_REQUESTS events appear under today", afterToday === baseToday + 2, `${baseToday} → ${afterToday}`);

  // A RELEASED operation was reconciled back — the series never counts it.
  const ev2 = await prisma.usageEvent.findFirst({ where: { businessId: BID, requestId: rid2 } });
  if (ev2) await prisma.usageEvent.update({ where: { id: ev2.id }, data: { status: "RELEASED" } });
  const afterRelease = await read(14);
  const releaseToday = afterRelease.data?.series?.find((d) => d.date === todayKey)?.requests ?? -1;
  ok("D8 RELEASED row excluded (back to +1)", releaseToday === baseToday + 1, `${afterToday} → ${releaseToday}`);

  // Server-side clamp: hostile days never echo back.
  const hostile1 = await read(999);
  ok("D9 ?days=999 clamps to the default 14", hostile1.data?.days === 14 && hostile1.data?.series?.length === 14, String(hostile1.data?.days));
  const hostile2 = await read("abc");
  ok("D10 ?days=abc clamps to the default 14", hostile2.data?.days === 14, String(hostile2.data?.days));
  const w7 = await read(7);
  ok("D11 ?days=7 honest window", w7.data?.days === 7 && w7.data?.series?.length === 7 && w7.data?.window?.to === todayKey);

  // Tenant isolation: a foreign business id can never shape the read
  // (the business is resolved server-side; the header selects ONLY among
  // the caller's own memberships — a foreign id is rejected upstream).
  const foreign = await f("/api/v1/billing/usage/series?days=14", {}, "cmforeign000000000000000000");
  ok("D12 foreign x-business-id never 200", foreign.status !== 200, String(foreign.status));

  await prisma.$disconnect();
} else {
  console.log("(part D skipped — set R135_QA_EMAIL / R135_QA_PW / R135_QA_BID)");
}

console.log(`\n== r135: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((x) => `  - ${x}`).join("\n"));
  process.exit(1);
}

/**
 * R115 — DASHBOARD TREND BATTERY (black-box, HTTP-only).
 *
 * The dashboard KPI tiles gained previous-window trend chips (R115). The
 * server truth lives in buildReportSummary's additive `trend` block:
 * the same-LENGTH business-local window immediately before the current
 * one (report-periods §6 law), percent changes per L8 (null on a ≤0
 * baseline — never a fabricated %).
 *
 * A. Live seeded proof (fresh business + REAL login + REAL APIs):
 *    - empty-business summary: stable zero shape + honest null pcts;
 *    - seeded current vs previous window figures with EXACT pct math;
 *    - the window-EDGE day (day before range.from) belongs to the
 *      PREVIOUS window, not the current one (L2/L5 no-overlap law);
 *    - negative net-cash baseline → pct null (L8, never a sign-flipped %);
 *    - custom from/to window: same-length previous resolution + zero
 *      baseline honesty.
 * B. Gates: 401 unauthenticated / 403 cross-tenant / 200 owner.
 * C. Cleanup: FK-safe sweep + census baseline 5/3.
 *
 * Run: bun scripts/r115-dashboard-trend-check.ts
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";
import { loginCredentials } from "./lib/platform-mfa";

const db = new PrismaClient();
const BASE = "http://localhost:3000";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Pure UTC date-key arithmetic (same law as report-periods addLocalDays). */
function addDays(key: string, n: number): string {
  const dt = new Date(`${key}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
/** Midnoon instant of a local key — immune to day-edge boundary races. */
const noonOf = (key: string) => `${key}T12:00:00.000Z`;

/* -------------------------------- fixtures -------------------------------- */

async function makeUser(email: string, name: string, pw: string) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  return db.user.create({
    data: { email, name, passwordHash: hashSync(pw, 10), emailVerifiedAt: new Date() },
  });
}

function mkJar() {
  const jar = new Map<string, string>();
  const f = async (path: string, init: RequestInit = {}, bizId?: string) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (bizId) headers["x-business-id"] = bizId;
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const raw = res.headers.get("set-cookie");
    if (raw) {
      for (const piece of raw.split(/,(?=[^;]+=)/)) {
        const [pair] = piece.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return res;
  };
  return { jar, f };
}

async function getJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------ A. live proof ----------------------------- */

async function liveProof() {
  console.log("== A. live seeded proof ==");
  const STAMP = Date.now().toString(36);
  const OWNER = `r115-trend-owner-${STAMP}@test.local`;
  const INTRUDER = `r115-trend-intruder-${STAMP}@test.local`;
  const PW = "R115-Trend-2026!";
  const BIZ = `R115 QA Ventures trend-${STAMP}`;

  await makeUser(OWNER, "R115 Trend Owner", PW);
  await makeUser(INTRUDER, "R115 Trend Intruder", PW);

  const owner = mkJar();
  await loginCredentials(owner.f, owner.jar, OWNER, PW);
  const bizRes = await owner.f("/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name: BIZ, currencyCode: "USD", locale: "en", timezone: "UTC" }),
  });
  const bizJson: any = await getJson(bizRes);
  const BID = bizJson?.data?.business?.id;
  check("A0 fresh business created (owner session live)", !!BID, `status ${bizRes.status}`);

  // ---- A1. EMPTY business: stable zero shape + honest null percentages ----
  const emptyRes = await owner.f("/api/v1/reports/summary?days=30", {}, BID);
  const empty: any = await getJson(emptyRes);
  const et = empty?.data?.trend;
  check(
    "A1 empty business: trend zero shape + ALL pcts null (L8)",
    emptyRes.status === 200 &&
      et?.revenuePrevMinor === 0 &&
      et?.revenueChangePct === null &&
      et?.collectedChangePct === null &&
      et?.expensesChangePct === null &&
      et?.netCashChangePct === null &&
      typeof et?.previousRange?.from === "string",
    `status ${emptyRes.status}, trend=${JSON.stringify(et?.previousRange)} pcts=${et?.revenueChangePct}/${et?.expensesChangePct}`,
  );
  const rangeFrom: string | undefined = empty?.data?.range?.from;
  if (!rangeFrom || !et) throw new Error("no anchor range — cannot seed deterministically");

  const todayKey = addDays(rangeFrom, 29); // rolling 30d window ends today
  const edgeKey = addDays(rangeFrom, -1); // the day BEFORE the window start
  if (addDays(todayKey, -29) !== rangeFrom) throw new Error("anchor arithmetic broken");

  // ---- Seed via the REAL APIs --------------------------------------------
  // Current window: sale $100.00 (today) + expense $30.00 (today) + payment IN $40.00 on the sale (today).
  // Previous window: sale $200.00 (EDGE day) + expense $50.00 (EDGE day) + payment IN $10.00 (EDGE day)
  //                  + payment OUT $60.00 on the expense (EDGE day → prev net cash NEGATIVE).
  const custRes = await owner.f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Trend Labs" }) }, BID);
  const cust: any = await getJson(custRes);
  const saleNow = await owner.f(
    "/api/v1/sales",
    { method: "POST", body: JSON.stringify({ customerId: cust?.data?.id, issueDate: noonOf(todayKey), items: [{ name: "Now widget", unit: "pcs", qty: 1, unitPriceMinor: 10000 }] }) },
    BID,
  );
  const saleNowJson: any = await getJson(saleNow);
  const salePrev = await owner.f(
    "/api/v1/sales",
    { method: "POST", body: JSON.stringify({ customerId: cust?.data?.id, issueDate: noonOf(edgeKey), items: [{ name: "Edge widget", unit: "pcs", qty: 2, unitPriceMinor: 10000 }] }) },
    BID,
  );
  const salePrevJson: any = await getJson(salePrev);
  const expNow = await owner.f(
    "/api/v1/expenses",
    { method: "POST", body: JSON.stringify({ description: "Now rent", amountMinor: 3000, spentAt: noonOf(todayKey), category: "rent" }) },
    BID,
  );
  const expPrev = await owner.f(
    "/api/v1/expenses",
    { method: "POST", body: JSON.stringify({ description: "Edge rent", amountMinor: 5000, spentAt: noonOf(edgeKey), category: "rent" }) },
    BID,
  );
  const expPrevJson: any = await getJson(expPrev);
  const seedOk =
    custRes.status === 201 &&
    saleNow.status === 201 &&
    salePrev.status === 201 &&
    expNow.status === 201 &&
    expPrev.status === 201;
  check("A2 seeded 2 sales + 2 expenses via REAL APIs", seedOk, `cust=${custRes.status} saleNow=${saleNow.status} salePrev=${salePrev.status} expNow=${expNow.status} expPrev=${expPrev.status}`);

  const saleNowId = saleNowJson?.data?.id ?? saleNowJson?.data?.sale?.id;
  const salePrevId = salePrevJson?.data?.id ?? salePrevJson?.data?.sale?.id;
  const expPrevId = expPrevJson?.data?.id ?? expPrevJson?.data?.expense?.id;
  const payInNow = await owner.f(
    "/api/v1/payments",
    { method: "POST", body: JSON.stringify({ saleId: saleNowId, amountMinor: 4000, method: "CASH", paidAt: noonOf(todayKey) }) },
    BID,
  );
  const payInPrev = await owner.f(
    "/api/v1/payments",
    { method: "POST", body: JSON.stringify({ saleId: salePrevId, amountMinor: 1000, method: "CASH", paidAt: noonOf(edgeKey) }) },
    BID,
  );
  const payOutPrev = await owner.f(
    "/api/v1/payments",
    { method: "POST", body: JSON.stringify({ expenseId: expPrevId, amountMinor: 4000, method: "BANK_TRANSFER", paidAt: noonOf(edgeKey) }) },
    BID,
  );
  check(
    "A3 payments seeded (IN now 40 / IN prev 10 / OUT prev 40 — edge-day paidAt honored)",
    payInNow.status === 201 && payInPrev.status === 201 && payOutPrev.status === 201,
    `inNow=${payInNow.status} inPrev=${payInPrev.status} outPrev=${payOutPrev.status}`,
  );

  // ---- A4. THE MAIN PROOF — exact trend math over the real window --------
  const sumRes = await owner.f("/api/v1/reports/summary?days=30", {}, BID);
  const sum: any = await getJson(sumRes);
  const k = sum?.data?.kpis;
  const t = sum?.data?.trend;
  const r = sum?.data?.range;

  check(
    "A4 current-window KPIs exact (rev 10000 / exp 3000 / collected 4000 / paidOut 0 / netCash 4000)",
    sumRes.status === 200 &&
      k?.revenueMinor === 10000 &&
      k?.expensesMinor === 3000 &&
      k?.collectedMinor === 4000 &&
      k?.paidOutMinor === 0 &&
      k?.netCashMinor === 4000,
    `status ${sumRes.status} kpis=${JSON.stringify(k)}`,
  );

  // Window-edge law: the edge-day sale ($200) is PREVIOUS-window revenue,
  // NOT current-window revenue (L5: no overlap, no gap).
  check(
    "A5 window-edge sale ($200 on the day before range.from) lands in PREVIOUS only",
    t?.revenuePrevMinor === 20000 && k?.revenueMinor === 10000,
    `prev=${t?.revenuePrevMinor} cur=${k?.revenueMinor}`,
  );
  check(
    "A6 previousRange == [from-30, from-1] (same length, no overlap)",
    t?.previousRange?.to === addDays(r?.from, -1) &&
      t?.previousRange?.from === addDays(r?.from, -30) &&
      t?.previousRange?.to < (r?.from ?? "9999"),
    `prev=[${t?.previousRange?.from} … ${t?.previousRange?.to}] cur=[${r?.from} … ${r?.to}]`,
  );
  check(
    "A7 exact pct math: revenue -50 / expenses -40 / collected +300",
    t?.revenueChangePct === -50 && t?.expensesChangePct === -40 && t?.collectedChangePct === 300,
    `rev=${t?.revenueChangePct} exp=${t?.expensesChangePct} col=${t?.collectedChangePct}`,
  );
  check(
    "A8 net-cash pct NULL on a NEGATIVE baseline (prev -3000) — L8, never sign-flipped %",
    t?.netCashPrevMinor === -3000 && t?.netCashChangePct === null,
    `netCashPrev=${t?.netCashPrevMinor} pct=${JSON.stringify(t?.netCashChangePct)}`,
  );
  check(
    "A9 counts carried (salesCountPrev 1 / expensesCountPrev 1)",
    t?.salesCountPrev === 1 && t?.expensesCountPrev === 1,
    `salesPrev=${t?.salesCountPrev} expPrev=${t?.expensesCountPrev}`,
  );

  // ---- A10. CUSTOM window: same-length previous + zero-baseline honesty ---
  // from = the EDGE day, to = today → 31 local days containing BOTH sales;
  // its previous window is [from-31 … from-1] — empty → zeros + null pcts.
  const customRes = await owner.f(
    `/api/v1/reports/summary?from=${edgeKey}&to=${todayKey}`,
    {},
    BID,
  );
  const custom: any = await getJson(customRes);
  const ck = custom?.data?.kpis;
  const ct = custom?.data?.trend;
  check(
    "A10 custom 31d window: both sales inside (rev 30000), previous window empty → prev 0 + pct null (L8)",
    customRes.status === 200 &&
      ck?.revenueMinor === 30000 &&
      ct?.revenuePrevMinor === 0 &&
      ct?.revenueChangePct === null,
    `status ${customRes.status} rev=${ck?.revenueMinor} prev=${ct?.revenuePrevMinor} pct=${JSON.stringify(ct?.revenueChangePct)}`,
  );

  // ---- B. gates ------------------------------------------------------------
  const noAuth = await fetch(`${BASE}/api/v1/reports/summary?days=30`, {
    headers: { "x-business-id": BID ?? "" },
  });
  check("B1 unauthenticated summary → 401", noAuth.status === 401, `status ${noAuth.status}`);

  const intruder = mkJar();
  await loginCredentials(intruder.f, intruder.jar, INTRUDER, PW);
  const cross = await intruder.f("/api/v1/reports/summary?days=30", {}, BID);
  check("B2 cross-tenant summary → 403 (tenant law)", cross.status === 403, `status ${cross.status}`);

  const ownerOk = await owner.f("/api/v1/reports/summary?days=30", {}, BID);
  check("B3 owner summary → 200 with trend block", ownerOk.status === 200 && !!(await getJson(ownerOk))?.data?.trend, `status ${ownerOk.status}`);

  return { BID };
}

/* ------------------------------- C. cleanup ------------------------------- */

async function cleanup() {
  console.log("== C. cleanup ==");
  const { execFileSync } = await import("node:child_process");
  // The battery users OWN businesses — direct user deletion would violate
  // FKs. The sweep is FK-safe child-first and matches BOTH the stamped
  // business prefix ("R115 QA Ventures") and the user email pattern.
  let out = "";
  try {
    out = execFileSync("bun", ["scripts/r104-user-sweep.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = `${((e as { stdout?: string })?.stdout ?? "")}${((e as { stderr?: string })?.stderr ?? "")}`;
  }
  const fk = await db.$queryRawUnsafe<{ n: number }[]>(`PRAGMA foreign_key_check`);
  const census = await db.$queryRawUnsafe<{ users: number; biz: number }[]>(
    `SELECT (SELECT COUNT(*) FROM "User") AS users, (SELECT COUNT(*) FROM "Business") AS biz`,
  );
  check(
    "C1 fk clean + sweep clean (residue 0 or nothing to sweep)",
    fk.length === 0 && (out.includes("residue: 0") || out.includes("nothing to sweep")),
    out.trim().split("\n").pop(),
  );
  check(
    "C2 census baseline 5/3",
    Number(census[0]?.users) === 5 && Number(census[0]?.biz) === 3,
    `users=${census[0]?.users} businesses=${census[0]?.biz}`,
  );
}

async function main() {
  await liveProof();
  await cleanup();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr115 dashboard-trend checks: ${checks.length - failed.length}/${checks.length} passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

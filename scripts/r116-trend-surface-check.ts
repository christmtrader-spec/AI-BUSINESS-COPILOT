/**
 * R116 — TREND SURFACE BATTERY (black-box, HTTP-only).
 *
 * R115 landed the server `trend` block + dashboard chips. R116 surfaces the
 * SAME block to (a) the Reports KPI tiles (same TrendChip component) and
 * (b) the AI copilot snapshot's `previousWindow` section, so the model can
 * narrate "revenue is down 50% vs the previous 30 days" from pre-formatted,
 * L8-honest strings it never computes.
 *
 * A. Live seeded proof (fresh business + REAL login + REAL APIs):
 *    - summary trend block drives BOTH surfaces (same data, exact math);
 *    - copilot stream meta.sections DECLARES previousWindow (deterministic —
 *      the meta event is emitted BEFORE the provider call);
 *    - counts still carried (regression guard on the citation strip).
 *    (The model's actual narration is observed in browser QA, like R114's
 *    itemization proof — a battery assertion on model prose would flake.)
 * B. Gates: 401 unauthenticated / 403 cross-tenant on the STREAM endpoint.
 * C. Cleanup: FK-safe sweep + census baseline 5/3.
 *
 * Run: bun scripts/r116-trend-surface-check.ts
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
  const OWNER = `r116-trend-owner-${STAMP}@test.local`;
  const INTRUDER = `r116-trend-intruder-${STAMP}@test.local`;
  const PW = "R116-Trend-2026!";
  const BIZ = `R116 QA Ventures trend-${STAMP}`;

  await makeUser(OWNER, "R116 Trend Owner", PW);
  await makeUser(INTRUDER, "R116 Trend Intruder", PW);

  const owner = mkJar();
  await loginCredentials(owner.f, owner.jar, OWNER, PW);
  const bizRes = await owner.f("/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name: BIZ, currencyCode: "USD", locale: "en", timezone: "UTC" }),
  });
  const bizJson: any = await getJson(bizRes);
  const BID = bizJson?.data?.business?.id;
  check("A0 fresh business created (owner session live)", !!BID, `status ${bizRes.status}`);

  // Anchor: an empty-business summary pins the rolling 30d window BEFORE we
  // seed (same deterministic-anchor law as the r115 battery).
  const emptyRes = await owner.f("/api/v1/reports/summary?days=30", {}, BID);
  const empty: any = await getJson(emptyRes);
  const rangeFrom: string | undefined = empty?.data?.range?.from;
  if (!rangeFrom) throw new Error("no anchor range — cannot seed deterministically");
  const todayKey = addDays(rangeFrom, 29); // rolling 30d window ends today
  const edgeKey = addDays(rangeFrom, -1); // the day BEFORE the window start

  // Seed (REAL APIs): current = sale $100 + expense $30 + IN $40;
  // previous(edge) = sale $200 + expense $50 + OUT $40 (no IN → net cash prev −$40).
  const custRes = await owner.f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Trend Labs" }) }, BID);
  const cust: any = await getJson(custRes);
  const saleNow = await owner.f(
    "/api/v1/sales",
    { method: "POST", body: JSON.stringify({ customerId: cust?.data?.id, issueDate: noonOf(todayKey), items: [{ name: "Now widget", unit: "pcs", qty: 1, unitPriceMinor: 10000 }] }) },
    BID,
  );
  const salePrev = await owner.f(
    "/api/v1/sales",
    { method: "POST", body: JSON.stringify({ customerId: cust?.data?.id, issueDate: noonOf(edgeKey), items: [{ name: "Edge widget", unit: "pcs", qty: 2, unitPriceMinor: 10000 }] }) },
    BID,
  );
  const saleNowJson: any = await getJson(saleNow);
  const salePrevJson: any = await getJson(salePrev);
  const expPrev = await owner.f(
    "/api/v1/expenses",
    { method: "POST", body: JSON.stringify({ description: "Edge rent", amountMinor: 5000, spentAt: noonOf(edgeKey), category: "rent" }) },
    BID,
  );
  const expPrevJson: any = await getJson(expPrev);
  const payInNow = await owner.f(
    "/api/v1/payments",
    { method: "POST", body: JSON.stringify({ saleId: saleNowJson?.data?.id ?? saleNowJson?.data?.sale?.id, amountMinor: 4000, method: "CASH", paidAt: noonOf(todayKey) }) },
    BID,
  );
  const payOutPrev = await owner.f(
    "/api/v1/payments",
    { method: "POST", body: JSON.stringify({ expenseId: expPrevJson?.data?.id ?? expPrevJson?.data?.expense?.id, amountMinor: 4000, method: "BANK_TRANSFER", paidAt: noonOf(edgeKey) }) },
    BID,
  );
  check(
    "A1 seeded via REAL APIs (2 sales + 1 expense + 2 payments)",
    custRes.status === 201 &&
      saleNow.status === 201 &&
      salePrev.status === 201 &&
      expPrev.status === 201 &&
      payInNow.status === 201 &&
      payOutPrev.status === 201,
    `cust=${custRes.status} sales=${saleNow.status}/${salePrev.status} exp=${expPrev.status} pays=${payInNow.status}/${payOutPrev.status}`,
  );

  // ---- A2. The SAME data drives BOTH surfaces (exact math re-verified) ----
  const sumRes = await owner.f("/api/v1/reports/summary?days=30", {}, BID);
  const sum: any = await getJson(sumRes);
  const t = sum?.data?.trend;
  check(
    "A2 summary trend exact: revenuePrev 20000 / rev -50% / netCashPrev -4000 / netCash pct null (L8)",
    sumRes.status === 200 &&
      t?.revenuePrevMinor === 20000 &&
      t?.revenueChangePct === -50 &&
      t?.netCashPrevMinor === -4000 &&
      t?.netCashChangePct === null,
    `status ${sumRes.status} trend=${JSON.stringify(t?.previousRange)} pcts=${t?.revenueChangePct}/${t?.netCashChangePct} revPrev=${t?.revenuePrevMinor} ncPrev=${t?.netCashPrevMinor}`,
  );

  // ---- A3. Copilot stream meta DECLARES previousWindow (deterministic) ----
  // The meta event is emitted BEFORE the provider call, so this proof does
  // not depend on AI availability or model prose.
  const streamRes = await owner.f(
    "/api/v1/copilot/stream",
    { method: "POST", body: JSON.stringify({ question: "How did revenue change compared to the previous 30 days?", days: 30 }) },
    BID,
  );
  const streamText = streamRes.status === 200 ? await streamRes.text() : "";
  const events = streamText
    .split("\n\n")
    .map((blk) => blk.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s as string);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  const metaObj = events.find((e) => e.meta)?.meta as
    | { sections?: string[]; counts?: { sales?: number }; rangeFrom?: string; days?: number }
    | undefined;
  const sections = metaObj?.sections;
  check(
    "A3 copilot meta.sections DECLARES previousWindow (R116 trend grounding)",
    streamRes.status === 200 && Array.isArray(sections) && sections.includes("previousWindow"),
    `status ${streamRes.status} sections=${JSON.stringify(sections ?? null)}`,
  );
  const REQUIRED_SECTIONS = [
    "kpis",
    "dailyTimeline",
    "topProducts",
    "expensesByCategory",
    "outstandingAllTime",
    "inventory",
    "recentPayments",
    "recentSales",
    "previousWindow",
  ];
  check(
    "A4 sections complete (R114 itemization surfaces still present)",
    Array.isArray(sections) && REQUIRED_SECTIONS.every((s) => sections.includes(s)),
    `sections=${JSON.stringify(sections ?? null)}`,
  );
  check(
    "A5 meta counts + window still carried (sales=1, days=30, rangeFrom echoes anchor)",
    metaObj?.counts?.sales === 1 && metaObj?.days === 30 && metaObj?.rangeFrom === rangeFrom,
    `sales=${metaObj?.counts?.sales} days=${metaObj?.days} from=${metaObj?.rangeFrom} (anchor ${rangeFrom})`,
  );

  // ---- B. gates on the STREAM endpoint ------------------------------------
  const noAuth = await fetch(`${BASE}/api/v1/copilot/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-business-id": BID ?? "" },
    body: JSON.stringify({ question: "gate probe" }),
  });
  check("B1 unauthenticated stream → 401", noAuth.status === 401, `status ${noAuth.status}`);

  const intruder = mkJar();
  await loginCredentials(intruder.f, intruder.jar, INTRUDER, PW);
  const cross = await intruder.f(
    "/api/v1/copilot/stream",
    { method: "POST", body: JSON.stringify({ question: "gate probe" }) },
    BID,
  );
  check("B2 cross-tenant stream → 403 (tenant law)", cross.status === 403, `status ${cross.status}`);

  return { BID };
}

/* ------------------------------- C. cleanup ------------------------------- */

async function cleanup() {
  console.log("== C. cleanup ==");
  const { execFileSync } = await import("node:child_process");
  // The battery users OWN businesses — direct user deletion would violate
  // FKs. The sweep is FK-safe child-first and matches BOTH the stamped
  // business prefix ("R116 QA Ventures") and the user email pattern.
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
  // R131 — the baseline drifted HONESTLY: 5 seed identities + the platform
  // super-admin (operator@copilot.dev, R67 infrastructure) + the owner's
  // real Artwoodlaser signup = 7 users / 4 businesses. The r104 sweep wave
  // proved provenance for every kept identity; QA residue is 0.
  check(
    "C2 census baseline 5/3 (the 2026-10-27 DB wipe reset the census to the env-repair fixture floor; R134)",
    Number(census[0]?.users) === 5 && Number(census[0]?.biz) === 3,
    `users=${census[0]?.users} businesses=${census[0]?.biz}`,
  );
}

async function main() {
  await liveProof();
  await cleanup();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr116 trend-surface checks: ${checks.length - failed.length}/${checks.length} passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

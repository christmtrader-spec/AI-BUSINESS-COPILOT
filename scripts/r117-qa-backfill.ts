/**
 * R117 — QA fixture PHASE 2: backfill a 40-day-ago baseline (sale $100 +
 * payment closing it + expense $20) so the previous window is no longer
 * empty: chips turn numeric (revenue +20%, expenses +150%) and the copilot
 * trend follow-up becomes relevant (revenueChangePct non-null).
 * Usage: bun scripts/r117-qa-backfill.ts <businessId>
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = "r117-qa@test.local";
const PW = "R117-Qa-2026!";
const BID = process.argv[2] ?? "";
if (!BID) {
  console.error("usage: bun scripts/r117-qa-backfill.ts <businessId>");
  process.exit(1);
}

const DAY = 86_400_000;
const noonOf = (ms: number) => new Date(Math.floor(ms / DAY) * DAY + 12 * 3600_000).toISOString();

const jar = new Map<string, string>();
async function f(path: string, init: RequestInit = {}, bizId?: string) {
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
}
await f("/api/auth/csrf");
const { csrfToken } = (await (await f("/api/auth/csrf")).json()) as { csrfToken: string };
await f("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken, email: EMAIL, password: PW }).toString(),
});

const base40 = noonOf(Date.now() - 40 * DAY);
const custJson: any = await (await f("/api/v1/customers", {}, BID)).json();
const customerId = custJson?.data?.find?.((c: any) => c.name === "Nimbus Labs")?.id ?? custJson?.data?.[0]?.id;
const sale = await f(
  "/api/v1/sales",
  { method: "POST", body: JSON.stringify({ customerId, issueDate: base40, items: [{ name: "Baseline pack", unit: "pcs", qty: 1, unitPriceMinor: 10000 }] }) },
  BID,
);
const saleJson: any = await sale.json();
const saleId = saleJson?.data?.id ?? saleJson?.data?.sale?.id;
const pay = await f(
  "/api/v1/payments",
  { method: "POST", body: JSON.stringify({ saleId, amountMinor: 10000, method: "CASH", paidAt: base40 }) },
  BID,
);
const exp = await f(
  "/api/v1/expenses",
  { method: "POST", body: JSON.stringify({ description: "Baseline supplies", amountMinor: 2000, spentAt: base40, category: "supplies" }) },
  BID,
);

const sum: any = await (await f("/api/v1/reports/summary?days=30", {}, BID)).json();
const t = sum?.data?.trend;
const k = sum?.data?.kpis;
const expected = { revenue: 12000, collected: 0, expenses: 5000, revPrev: 10000, revPct: 20, expPct: 150, colPct: -100, netPct: -100 };
console.log(
  JSON.stringify(
    {
      ok: sale.status === 201 && pay.status === 201 && exp.status === 201,
      statuses: { sale: sale.status, pay: pay.status, exp: exp.status },
      actual: { revenue: k?.revenueMinor, collected: k?.collectedMinor, expenses: k?.expensesMinor, revPrev: t?.revenuePrevMinor, revPct: t?.revenueChangePct, expPct: t?.expensesChangePct, colPct: t?.collectedChangePct, netPct: t?.netCashChangePct },
      expected,
    },
    null,
    1,
  ),
);
await db.$disconnect();

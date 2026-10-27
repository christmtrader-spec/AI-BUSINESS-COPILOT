/** R116 — verify the QA fixture's trend numbers BEFORE the browser step. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = "r116-qa@test.local";
const PW = "R116-Qa-2026!";
const BID = process.argv[2] ?? "";
if (!BID) {
  console.error("usage: bun scripts/r116-qa-verify.ts <businessId>");
  process.exit(1);
}

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

const sum: any = await (await f("/api/v1/reports/summary?days=30", {}, BID)).json();
const k = sum?.data?.kpis;
const t = sum?.data?.trend;
console.log(
  JSON.stringify(
    {
      kpis: { revenue: k?.revenueMinor, collected: k?.collectedMinor, expenses: k?.expensesMinor, netCash: k?.netCashMinor },
      trend: {
        prev: t?.revenuePrevMinor,
        revPct: t?.revenueChangePct,
        colPct: t?.collectedChangePct,
        expPct: t?.expensesChangePct,
        netPct: t?.netCashChangePct,
        range: t?.previousRange,
      },
      expected: { revenue: 24600, collected: 24600, expenses: 35000, netCash: 24600, prev: 20000, revPct: 23, colPct: 23, expPct: 250, netPct: 23 },
    },
    null,
    1,
  ),
);
await db.$disconnect();

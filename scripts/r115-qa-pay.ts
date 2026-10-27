/**
 * R115 — QA one-shot: record a $246 payment on the oldest open invoice of
 * the R115 QA fixture business → receivable count drops to 1 (singular
 * plural proof) and COLLECTED/NET-CASH gain a non-zero current window with
 * a zero baseline (the trend chip "New" state). Swept with the fixture.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = "r115-qa@test.local";
const PW = "R115-Qa-2026!";

const user = await db.user.findUnique({ where: { email: EMAIL } });
if (!user) throw new Error("fixture user missing");
const membership = await db.businessMember.findFirst({
  where: { userId: user.id, business: { name: { startsWith: "R115 QA Ventures" } } },
  include: { business: { select: { id: true } } },
  orderBy: { createdAt: "desc" },
});
if (!membership) throw new Error("no R115 QA Ventures business");
const BID = membership.business.id;

const sale = await db.sale.findFirst({
  where: { businessId: BID, deletedAt: null, status: { not: "PAID" } },
  orderBy: { issueDate: "asc" },
  select: { id: true, totalMinor: true },
});
if (!sale) throw new Error("no open sale");

const jar = new Map<string, string>();
async function f(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    "x-business-id": BID,
  };
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
const csrf = (await (await f("/api/auth/csrf")).json()) as { csrfToken: string };
await f("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken: csrf.csrfToken, email: EMAIL, password: PW }).toString(),
});

const pay = await f("/api/v1/payments", {
  method: "POST",
  body: JSON.stringify({ saleId: sale.id, amountMinor: sale.totalMinor, method: "CASH" }),
});
console.log(JSON.stringify({ payment: pay.status, saleMinor: sale.totalMinor }));
await db.$disconnect();

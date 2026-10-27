/**
 * R115 — QA backfill: add PREVIOUS-window records to the r115 browser-QA
 * business so the dashboard trend chips render real percentages (not just
 * the "New" no-baseline state). One-shot; swept with the fixture.
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
  include: { business: { select: { id: true, name: true } } },
  orderBy: { createdAt: "desc" },
});
if (!membership) throw new Error("no R115 QA Ventures business for fixture user");
const BID = membership.business.id;
console.log(`backfilling ${membership.business.name} (${BID})`);

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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const cust = (await (await f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Baseline Trading Co" }) })).json()) as any;
const sale = await f("/api/v1/sales", {
  method: "POST",
  body: JSON.stringify({
    customerId: cust?.data?.id,
    issueDate: daysAgo(40),
    items: [{ name: "Baseline retainer", unit: "pcs", qty: 1, unitPriceMinor: 30000 }],
  }),
});
const exp = await f("/api/v1/expenses", {
  method: "POST",
  body: JSON.stringify({ description: "Baseline tools", amountMinor: 10000, spentAt: daysAgo(40), category: "software" }),
});
console.log(JSON.stringify({ sale: sale.status, expense: exp.status }));
await db.$disconnect();

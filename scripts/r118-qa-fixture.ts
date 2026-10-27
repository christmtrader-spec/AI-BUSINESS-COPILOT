/**
 * R118 — browser-QA fixture: fresh tenant + business seeded so the copilot's
 * EMPTY-STATE suggestions (R118: per-subject icons + the new trend chip)
 * show the designed picture:
 *
 *   baseline (40 days ago → PREVIOUS window): sale $200 + expense $100
 *             + payment IN $200 closing that invoice;
 *   today    (CURRENT window):                sale $246 (3×$49 + $99)
 *             + expense $350 + payment IN $246 closing it.
 *
 * Expected on days=30: revenue +23% → hasTrendPct true → the empty-state
 * suggestionTrend chip is the LEAD suggestion (GitCompareArrows icon) and
 * outstanding (receivable 0) + low-stock (none) chips are HIDDEN.
 * After any first question, the answer's follow-ups may lead with the
 * trend chip (model prose depending).
 *
 * Output: JSON {email, password, businessId} for the browser step.
 * Sweep: "r118-qa@test.local" + prefix "R118 QA Ventures" are registered
 * BEFORE this fixture runs (the R117 lesson).
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const STAMP = Date.now().toString(36);
const EMAIL = "r118-qa@test.local";
const PW = "R118-Qa-2026!";
const BIZ = `R118 QA Ventures ${STAMP}`;

const DAY = 86_400_000;
const noonOf = (ms: number) => new Date(Math.floor(ms / DAY) * DAY + 12 * 3600_000).toISOString();

// 1. fixture user (idempotent)
const existing = await db.user.findUnique({ where: { email: EMAIL } });
const user =
  existing ??
  (await db.user.create({
    data: { email: EMAIL, name: "R118 QA", passwordHash: hashSync(PW, 10), emailVerifiedAt: new Date() },
  }));

// 2. login via the REAL credentials flow (triple-check law)
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
const csrfRes = await f("/api/auth/csrf");
const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
const loginRes = await f("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken, email: EMAIL, password: PW }).toString(),
});
const loc = loginRes.headers.get("location") ?? "";
if ((loginRes.status !== 302 && loginRes.status !== 200) || loc.includes("error=") || !jar.has("next-auth.session-token")) {
  console.error(`login failed: ${loginRes.status} ${loc.slice(0, 120)}`);
  process.exit(1);
}

// 3. business (owner)
const bizRes = await f("/api/v1/businesses", {
  method: "POST",
  body: JSON.stringify({ name: BIZ, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const bizJson: any = await bizRes.json();
const BID = bizJson?.data?.business?.id;
if (!BID) {
  console.error(`business failed: ${bizRes.status} ${JSON.stringify(bizJson).slice(0, 160)}`);
  process.exit(1);
}

// 4. seed — customer, baseline (40d ago), current (today)
const now = Date.now();
const base40 = noonOf(now - 40 * DAY); // lands in the PREVIOUS 30d window
const today = noonOf(now);

const cust = await f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Aurora Labs", email: "billing@aurora-labs.test" }) }, BID);
const custJson: any = await cust.json();

const saleBase = await f(
  "/api/v1/sales",
  { method: "POST", body: JSON.stringify({ customerId: custJson?.data?.id, issueDate: base40, items: [{ name: "Baseline pack", unit: "pcs", qty: 1, unitPriceMinor: 20000 }] }) },
  BID,
);
const saleBaseJson: any = await saleBase.json();
const saleBaseId = saleBaseJson?.data?.id ?? saleBaseJson?.data?.sale?.id;

const saleNow = await f(
  "/api/v1/sales",
  {
    method: "POST",
    body: JSON.stringify({
      customerId: custJson?.data?.id,
      issueDate: today,
      items: [
        { name: "Copilot QA subscription", unit: "pcs", qty: 3, unitPriceMinor: 4900 },
        { name: "Onboarding pack", unit: "pcs", qty: 1, unitPriceMinor: 9900 },
      ],
    }),
  },
  BID,
);
const saleNowJson: any = await saleNow.json();
const saleNowId = saleNowJson?.data?.id ?? saleNowJson?.data?.sale?.id;

const expBase = await f(
  "/api/v1/expenses",
  { method: "POST", body: JSON.stringify({ description: "Baseline rent", amountMinor: 10000, spentAt: base40, category: "rent" }) },
  BID,
);
const expNow = await f(
  "/api/v1/expenses",
  { method: "POST", body: JSON.stringify({ description: "QA office rent", amountMinor: 35000, spentAt: today, category: "rent" }) },
  BID,
);

const payBase = await f(
  "/api/v1/payments",
  { method: "POST", body: JSON.stringify({ saleId: saleBaseId, amountMinor: 20000, method: "CASH", paidAt: base40 }) },
  BID,
);
const payNow = await f(
  "/api/v1/payments",
  { method: "POST", body: JSON.stringify({ saleId: saleNowId, amountMinor: 24600, method: "BANK_TRANSFER", paidAt: today }) },
  BID,
);

const ok =
  cust.status === 201 &&
  saleBase.status === 201 &&
  saleNow.status === 201 &&
  expBase.status === 201 &&
  expNow.status === 201 &&
  payBase.status === 201 &&
  payNow.status === 201;

console.log(
  JSON.stringify({
    ok,
    email: EMAIL,
    password: PW,
    businessId: BID,
    businessName: BIZ,
    statuses: { cust: cust.status, saleBase: saleBase.status, saleNow: saleNow.status, expBase: expBase.status, expNow: expNow.status, payBase: payBase.status, payNow: payNow.status },
  }),
);
await db.$disconnect();
if (!ok) process.exit(1);

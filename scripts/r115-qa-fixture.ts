/**
 * R115 — browser-QA fixture: fresh tenant + business with REAL seeded data
 * (customer + sale + expense) so dashboard/copilot have something grounded.
 * Idempotent-ish: creates a NEW business per run (AI quota-safe, smoke §7
 * pattern); the sweep removes the user + all "R115 QA" businesses.
 *
 * Output: JSON {email, password, businessId} for the browser step.
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const STAMP = Date.now().toString(36);
const EMAIL = "r115-qa@test.local";
const PW = "R115-Qa-2026!";
const BIZ = `R115 QA Ventures ${STAMP}`;

// 1. fixture user (idempotent)
const existing = await db.user.findUnique({ where: { email: EMAIL } });
const user =
  existing ??
  (await db.user.create({
    data: { email: EMAIL, name: "R115 QA", passwordHash: hashSync(PW, 10), emailVerifiedAt: new Date() },
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

// 4. seed: customer + sale + expense (grounded data)
const cust = await f(
  "/api/v1/customers",
  { method: "POST", body: JSON.stringify({ name: "Aurora Labs", email: "billing@aurora-labs.test" }) },
  BID,
);
const custJson: any = await cust.json();
const sale = await f(
  "/api/v1/sales",
  {
    method: "POST",
    body: JSON.stringify({
      customerId: custJson?.data?.id,
      issueDate: new Date().toISOString(),
      items: [
        { name: "Copilot QA subscription", unit: "pcs", qty: 3, unitPriceMinor: 4900 },
        { name: "Onboarding pack", unit: "pcs", qty: 1, unitPriceMinor: 9900 },
      ],
    }),
  },
  BID,
);
const exp = await f(
  "/api/v1/expenses",
  {
    method: "POST",
    body: JSON.stringify({
      description: "QA office rent",
      amountMinor: 35000,
      date: new Date().toISOString(),
      category: "rent",
    }),
  },
  BID,
);

console.log(
  JSON.stringify({
    email: EMAIL,
    password: PW,
    businessId: BID,
    businessName: BIZ,
    customer: cust.status,
    sale: sale.status,
    expense: exp.status,
  }),
);
await db.$disconnect();

/**
 * TEMP QA script (P51-R1-FINAL §4): extends the sanctioned browser fixture
 * with the special quantity/unit cases required by the final task:
 *   - Persian unit label "عدد"
 *   - null unit
 *   - long (20-char) unit
 *   - large quantity
 *   - negative quantity (via the REAL stock-adjust path — create cannot
 *     go negative per productCreateSchema; adjust delta -4 on qty 2 → -2)
 * Deleted after the browser QA session. Owner: p51qa-owner@test.local.
 */
const BASE = "http://localhost:3000";
const EMAIL = "p51qa-owner@test.local";
const PASS = "testpass123";
const jar = new Map();

async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
await f("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken: csrf, email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString(),
});
const me = await f("/api/v1/me");
if (me.status !== 200) throw new Error(`login failed: ${me.status}`);
const bizList = await f("/api/v1/businesses");
if (bizList.status !== 200) throw new Error(`business list failed: ${bizList.status}`);
const bizId = bizList.body?.data?.find((m) => m.business?.name === "P51QA-VISUAL")?.business?.id ?? bizList.body?.data?.[0]?.business?.id;
if (!bizId) throw new Error("no business on fixture owner");
const HA = { "x-business-id": bizId };

const created = {};
for (const p of [
  { key: "fa", body: { name: "Unit Persian", sku: "SKU-UNIT-FA", unit: "عدد", salePriceMinor: 3000, costPriceMinor: 1500, stockQty: 5 } },
  { key: "null", body: { name: "Unit Null", sku: "SKU-UNIT-NONE", salePriceMinor: 2500, costPriceMinor: 1250, stockQty: 7 } },
  { key: "long", body: { name: "Unit Long", sku: "SKU-UNIT-LONG", unit: "kilogram-meter-long", salePriceMinor: 4000, costPriceMinor: 2000, stockQty: 9 } },
  { key: "big", body: { name: "Qty Large", sku: "SKU-QTY-BIG", unit: "m", salePriceMinor: 1200, costPriceMinor: 999, stockQty: 1234567 } },
  { key: "neg", body: { name: "Qty Negative", sku: "SKU-QTY-NEG", unit: "m", salePriceMinor: 800, costPriceMinor: 400, stockQty: 2 } },
]) {
  // Idempotent: find by SKU first (re-runs must not duplicate).
  const found = await f(`/api/v1/products?q=${encodeURIComponent(p.body.sku)}`, { headers: HA });
  const existing = found.body?.data?.items?.find((it) => it.sku === p.body.sku);
  if (existing) {
    created[p.key] = existing.id;
    console.log(`found ${p.key}: ${existing.id}`);
    continue;
  }
  const r = await f("/api/v1/products", { method: "POST", headers: HA, body: JSON.stringify(p.body) });
  if (r.status !== 201) throw new Error(`create ${p.key} failed: ${r.status} ${JSON.stringify(r.body)}`);
  created[p.key] = r.body.data.id;
  console.log(`created ${p.key}: ${r.body.data.id}`);
}

// Negative quantity: the simple stock API contract forbids going below zero
// (422 INSUFFICIENT_STOCK — verified live). The sanctioned browser fixture
// applies such states directly at the DB level ("2 db-level states applied"),
// so mirror that documented convention here.
const { createRequire } = await import("node:module");
const req = createRequire(new URL("../../package.json", import.meta.url));
const { PrismaClient } = req("@prisma/client");
const db = new PrismaClient();
await db.product.update({ where: { id: created.neg }, data: { stockQty: -2 } });
const negAfter = await db.product.findUnique({ where: { id: created.neg }, select: { stockQty: true } });
await db.$disconnect();
if (negAfter?.stockQty !== -2) throw new Error("negative stock case failed");
console.log("P51-R1-FINAL §4 special-unit products ready (neg qty =", negAfter.stockQty, ")");

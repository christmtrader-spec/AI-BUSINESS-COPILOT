/**
 * scripts/r103-tile-api-proofs.ts — R103 THE INVENTORY TILE ROUND real-HTTP
 * proofs (the meta's RUNNER-UP + the throne-of-one honesty over the wire).
 *
 *  [A] HONEST SILENCE — a fresh book: meta.topStockRunnerUp present-and-NULL.
 *  [B] THE THRONE OF ONE — exactly one product: the crown maps, the
 *      runner-up stays NULL (padding a runner-up over the wire would be a
 *      lie; the Medal chip must never render from one).
 *  [C] THE FULL THRONE — the R102 seed (Bulk Screws 2M, Ghost Gear 1.2M
 *      INACTIVE, Akar 1M, Free Sample 0): the meta's runner-up is rank 2
 *      VERBATIM (id+name+value) and THE READERS AGREE — meta.runnerUp ===
 *      the summary's inventory.topValueProducts[1] byte-for-byte; the
 *      inactive rank 2 rides the meta (ADR 0051 §6 over the wire).
 *  [D] THE FLIP — PATCH Akar's cost 100k→300k: the throne moves to
 *      [Akar 3M, Bulk 2M] and the runner-up FOLLOWS (Bulk Screws) — the
 *      fact rides the response, never cached.
 *  [E] 401 — the unauthenticated are rejected.
 *
 * Run: bun --conditions react-server scripts/r103-tile-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r103-tile-probe@qa.local";
const PASS = "testpass123";
const TZ = "Asia/Tehran";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

export {};

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": `10.228.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  };
}

async function login(email: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken, email, password: PASS });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return jar;
}

let BIZ_ID = "";

async function api(jar: Map<string, string>, path: string, init: RequestInit = {}) {
  const f = jarFetch(jar);
  const res = await f(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-business-id": BIZ_ID,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (body && typeof body === "object" && "data" in body) body = body.data;
  return { status: res.status, body };
}

async function cleanup() {
  const user = await db.user.findFirst({ where: { email: EMAIL } });
  if (!user) return;
  const businesses = await db.business.findMany({ where: { ownerId: user.id }, select: { id: true } });
  for (const b of businesses) await db.business.delete({ where: { id: b.id } }); // cascades everything
  await db.userSession.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  console.log(`cleanup: swept probe user + ${businesses.length} business(es) FK-safe`);
}

async function seed() {
  const passwordHash = await import("bcryptjs").then((m) => m.default.hashSync(PASS, 10));
  const user = await db.user.create({
    data: { email: EMAIL, name: "R103 Tile Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R103 Tile Probe Co",
      slug: `r103-tile-probe-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: user.id,
      vatEnabled: false,
    },
  });
  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  return { user, business };
}

async function grounding(days = 30) {
  const { buildCopilotGrounding } = await import("../src/lib/ai/snapshot");
  const business = await db.business.findUniqueOrThrow({ where: { id: BIZ_ID } });
  const g = await buildCopilotGrounding({
    businessId: BIZ_ID,
    business: {
      name: business.name,
      currencyCode: business.currencyCode,
      currencySymbol: business.currencySymbol,
      decimalPrecision: business.decimalPrecision,
      locale: business.locale,
      timezone: business.timezone,
    },
    days: days as 7 | 30 | 90,
    uiLocale: "en",
  });
  return { meta: g.meta as any, systemPrompt: g.systemPrompt, snapshot: JSON.parse(g.dataBlock) };
}

async function main() {
  await cleanup(); // defensive pre-sweep (fixed email → deterministic)

  const { business } = await seed();
  BIZ_ID = business.id;
  console.log(`probe business: ${BIZ_ID} (FREE)`);

  const jar = await login(EMAIL);

  console.log("\n[A] HONEST SILENCE — a fresh book");
  const fresh = await grounding(30);
  ok(
    "A1 meta.topStockRunnerUp present-and-NULL on a fresh book (the Medal gate reads falsy)",
    fresh.meta.topStockRunnerUp === null,
    JSON.stringify(fresh.meta.topStockRunnerUp),
  );

  console.log("\n[B] THE THRONE OF ONE — the padding lie is impossible over the wire");
  const only = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Lone Product", salePriceMinor: 250_000, costPriceMinor: 100_000, stockQty: 5, lowStockAt: 1 }),
  });
  ok("B1 the lone product created", only.status === 201 || only.status === 200, String(only.status));
  const sumOne = await api(jar, "/api/v1/reports/summary?days=30");
  ok(
    "B2 the summary's throne has EXACTLY one entry",
    Array.isArray(sumOne.body?.inventory?.topValueProducts) && sumOne.body.inventory.topValueProducts.length === 1,
    JSON.stringify(sumOne.body?.inventory?.topValueProducts),
  );
  const metaOne = await grounding(30);
  ok(
    "B3 the crown maps; the runner-up stays NULL (never padded from one)",
    metaOne.meta.topStockProduct?.name === "Lone Product" && metaOne.meta.topStockProduct?.valueMinor === 500_000 && metaOne.meta.topStockRunnerUp === null,
    JSON.stringify({ crown: metaOne.meta.topStockProduct, ru: metaOne.meta.topStockRunnerUp }),
  );

  console.log("\n[C] THE FULL THRONE — the runner-up is rank 2 VERBATIM, the readers agree");
  const pBulk = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Bulk Screws", salePriceMinor: 5_000, costPriceMinor: 2_000, stockQty: 1000, lowStockAt: 10 }),
  });
  const pGhost = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Ghost Gear", salePriceMinor: 900_000, costPriceMinor: 400_000, stockQty: 3, lowStockAt: 1 }),
  });
  const pAkar = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Akar Widget", salePriceMinor: 800_000, costPriceMinor: 100_000, stockQty: 10, lowStockAt: 2 }),
  });
  ok("C1 three more products created", pBulk.status === 201 && pGhost.status === 201 && pAkar.status === 201);
  const deact = await api(jar, "/api/v1/products/bulk-status", {
    method: "POST",
    body: JSON.stringify({ ids: [pGhost.body.id], isActive: false }),
  });
  ok("C2 Ghost Gear deactivated (the rank 2 is INACTIVE — the inclusion law over the wire)", deact.status === 200, String(deact.status));
  const sum = await api(jar, "/api/v1/reports/summary?days=30");
  const throne = sum.body?.inventory?.topValueProducts;
  ok(
    "C3 the wire throne EXACT [Bulk Screws 2M, Ghost Gear 1.2M] (inactive rank 2 included)",
    JSON.stringify(throne) === JSON.stringify([
      { productId: pBulk.body.id, name: "Bulk Screws", estimatedValueMinor: 2_000_000 },
      { productId: pGhost.body.id, name: "Ghost Gear", estimatedValueMinor: 1_200_000 },
    ]),
    JSON.stringify(throne),
  );
  const metaFull = await grounding(30);
  ok(
    "C4 THE READERS AGREE — meta.topStockRunnerUp === the summary's rank 2 (id+name+value verbatim)",
    metaFull.meta.topStockRunnerUp &&
      metaFull.meta.topStockRunnerUp.id === throne[1].productId &&
      metaFull.meta.topStockRunnerUp.name === throne[1].name &&
      metaFull.meta.topStockRunnerUp.valueMinor === throne[1].estimatedValueMinor,
    JSON.stringify({ meta: metaFull.meta.topStockRunnerUp, throne2: throne[1] }),
  );
  ok(
    "C5 the crown still agrees (rank 1 === Bulk Screws 2M)",
    metaFull.meta.topStockProduct?.id === throne[0].productId && metaFull.meta.topStockProduct?.valueMinor === 2_000_000,
  );

  console.log("\n[D] THE FLIP — the runner-up follows the value order, never cached");
  const flip = await api(jar, `/api/v1/products/${pAkar.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ costPriceMinor: 300_000 }),
  });
  ok("D1 Akar cost PATCH 200", flip.status === 200, String(flip.status));
  const sum2 = await api(jar, "/api/v1/reports/summary?days=30");
  const throne2 = sum2.body?.inventory?.topValueProducts;
  ok(
    "D2 the throne FLIPPED to [Akar 3M, Bulk Screws 2M]",
    JSON.stringify(throne2) === JSON.stringify([
      { productId: pAkar.body.id, name: "Akar Widget", estimatedValueMinor: 3_000_000 },
      { productId: pBulk.body.id, name: "Bulk Screws", estimatedValueMinor: 2_000_000 },
    ]),
    JSON.stringify(throne2),
  );
  const meta2 = await grounding(30);
  ok(
    "D3 the runner-up FOLLOWS (Bulk Screws 2M — the meta rides the response)",
    meta2.meta.topStockRunnerUp?.id === pBulk.body.id && meta2.meta.topStockRunnerUp?.valueMinor === 2_000_000,
    JSON.stringify(meta2.meta.topStockRunnerUp),
  );
  ok(
    "D4 the crown FOLLOWS (Akar 3M) — one fact, two readers, zero drift",
    meta2.meta.topStockProduct?.id === pAkar.body.id && meta2.meta.topStockProduct?.valueMinor === 3_000_000,
  );

  console.log("\n[E] 401 — the unauthenticated are rejected");
  const anon = await fetch(`${BASE}/api/v1/reports/summary?days=30`, { redirect: "manual" });
  ok("E1 summary 401 for the unauthenticated", anon.status === 401, String(anon.status));

  if (process.argv.includes("--keep")) {
    console.log(`\nKEEP MODE — probe book kept for browser QA:
  login: ${EMAIL} / ${PASS}
  businessId: ${BIZ_ID}`);
    return;
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("FAILURES:", failures.join(" | "));
    process.exit(1);
  }
  process.exit(0);
}

await main();

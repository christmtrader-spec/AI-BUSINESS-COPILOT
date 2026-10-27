/**
 * scripts/r102-stock-api-proofs.ts — R102 STOCK THRONE REAL-HTTP PROOFS.
 *
 * Proves the stock-throne round end-to-end over live HTTP:
 *
 *  [A] HONEST SILENCE — a fresh book: the summary's inventory carries
 *      topValueProducts present-and-[] and the grounding meta carries
 *      topStockProduct present-and-NULL (the chip gate reads falsy).
 *  [B] THE SEED — engineered so the VALUE rank is NOT the name order and
 *      an INACTIVE product holds rank 2 (the ADR 0051 §6 inclusion law —
 *      an inactive product can still hold stock): Bulk Screws 1000×2k=2M,
 *      Ghost Gear 3×400k=1.2M (then deactivated), Akar Widget 10×100k=1M,
 *      Free Sample 10×0=0 (the zero-cost honesty).
 *  [C] THE WIRE — the summary's inventory.topValueProducts is EXACT
 *      [Bulk Screws 2M, Ghost Gear 1.2M] with stable ids.
 *  [D] CROSS-SURFACE AGREEMENT — the valuation route's OWN
 *      topValueProducts (its default filters = the complete set) equals
 *      the summary's throne BYTE-FOR-BYTE — the ONE authority over the
 *      wire; the crown can never disagree with the panel's table.
 *  [E] RECONCILIATION (Gate D twin) — the summary's inventory.valueMinor
 *      === 4.2M exactly and === the valuation totals.estimatedValueMinor.
 *  [F] THE ZERO-COST HONESTY — Free Sample rides the valuation rows at
 *      value 0 (ZERO_COST), never crowned.
 *  [G] THE FLIP — PATCH Akar's cost 100k→300k (1M→3M): the throne moves
 *      to [Akar 3M, Bulk Screws 2M] — the fact rides the response, never
 *      cached; and the meta FOLLOWS (the READERS AGREE: meta.topStockProduct
 *      === the summary's rank 1, name + id + value verbatim).
 *  [H] THE ADDITIVE LAW — the summary JSON's inventory section grew
 *      EXACTLY one key (topValueProducts) and the top-level key set is
 *      untouched; the system prompt carries the 6f law.
 *  [I] 401 — the summary route rejects the unauthenticated (and the probe
 *      book rides FREE — the valuation deep link needs NO entitlement).
 *
 * Run: bun --conditions react-server scripts/r102-stock-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r102-stock-probe@qa.local";
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
      const [pair] = raw.split(";");
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
    data: { email: EMAIL, name: "R102 Stock Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R102 Stock Probe Co",
      slug: `r102-stock-probe-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: user.id,
      vatEnabled: false,
    },
  });
  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  // NO subscription flip — the book rides FREE on purpose: the valuation
  // deep link (Prompt 51) needs NO entitlement, and this round's surfaces
  // must serve every plan.
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
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }
  await cleanup(); // defensive pre-sweep (fixed email → deterministic)

  const { user, business } = await seed();
  BIZ_ID = business.id;
  console.log(`probe business: ${BIZ_ID} (FREE — the valuation needs no entitlement)`);

  const jar = await login(EMAIL);

  console.log("\n[A] HONEST SILENCE — a fresh book");
  const fresh = await api(jar, "/api/v1/reports/summary?days=30");
  ok("A1 summary 200 on a fresh FREE book", fresh.status === 200, String(fresh.status));
  ok(
    "A2 inventory.topValueProducts present-and-[] (additive honesty — never absent on the wire)",
    Array.isArray(fresh.body?.inventory?.topValueProducts) && fresh.body.inventory.topValueProducts.length === 0,
    JSON.stringify(fresh.body?.inventory?.topValueProducts),
  );
  const freshMeta = await grounding(30);
  ok(
    "A3 meta.topStockProduct present-and-NULL on a fresh book (the chip gate reads falsy)",
    "topStockProduct" in freshMeta.meta && freshMeta.meta.topStockProduct === null,
    JSON.stringify(freshMeta.meta.topStockProduct),
  );

  console.log("\n[B] THE SEED — the VALUE rank engineered off the name order + an INACTIVE rank 2");
  const pBulk = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Bulk Screws", salePriceMinor: 5_000, costPriceMinor: 2_000, stockQty: 1000, lowStockAt: 100 }),
  });
  const pGhost = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Ghost Gear", salePriceMinor: 900_000, costPriceMinor: 400_000, stockQty: 3, lowStockAt: 2 }),
  });
  const pAkar = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Akar Widget", salePriceMinor: 800_000, costPriceMinor: 100_000, stockQty: 10, lowStockAt: 3 }),
  });
  const pFree = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Free Sample", salePriceMinor: 0, costPriceMinor: 0, stockQty: 10, lowStockAt: 2 }),
  });
  ok(
    "B1 four products created",
    [pBulk, pGhost, pAkar, pFree].every((r) => r.status === 201),
    [pBulk, pGhost, pAkar, pFree].map((r) => r.status).join("/"),
  );
  // Deactivate Ghost Gear AFTER creation — it still holds stock (ADR 0051 §6:
  // an inactive product can still hold stock → it STAYS in the valuation
  // population and may be crowned).
  const deact = await api(jar, "/api/v1/products/bulk-status", {
    method: "POST",
    body: JSON.stringify({ ids: [pGhost.body.id], isActive: false }),
  });
  ok("B2 Ghost Gear deactivated (bulk-status 200)", deact.status === 200, `${deact.status} ${JSON.stringify(deact.body)}`);

  console.log("\n[C] THE WIRE — the summary's throne is EXACT");
  const sum = await api(jar, "/api/v1/reports/summary?days=30");
  const throne = sum.body?.inventory?.topValueProducts;
  ok(
    "C1 throne EXACT [Bulk Screws 2M, Ghost Gear 1.2M] — ids stable, order by VALUE",
    JSON.stringify(throne) ===
      JSON.stringify([
        { productId: pBulk.body.id, name: "Bulk Screws", estimatedValueMinor: 2_000_000 },
        { productId: pGhost.body.id, name: "Ghost Gear", estimatedValueMinor: 1_200_000 },
      ]),
    JSON.stringify(throne),
  );
  ok(
    "C2 Akar Widget (1M) is rank 3 — NEVER crowned at take=2",
    !throne.some((p: any) => p.productId === pAkar.body.id),
    JSON.stringify(throne),
  );
  ok(
    "C3 Free Sample (0) never crowned — the zero-cost honesty",
    !throne.some((p: any) => p.productId === pFree.body.id),
    JSON.stringify(throne),
  );

  console.log("\n[D] CROSS-SURFACE AGREEMENT — the ONE authority over the wire");
  const val = await api(jar, "/api/v1/reports/inventory-valuation?page=1&pageSize=50");
  ok("D1 valuation route 200 on a FREE book (no entitlement gate)", val.status === 200, String(val.status));
  ok(
    "D2 the valuation's OWN throne === the summary's throne BYTE-FOR-BYTE",
    JSON.stringify(val.body?.topValueProducts) === JSON.stringify(throne),
    `${JSON.stringify(val.body?.topValueProducts)} vs ${JSON.stringify(throne)}`,
  );

  console.log("\n[E] RECONCILIATION — the Gate D twin");
  ok(
    "E1 summary valueMinor === 4.2M exactly (2M + 1.2M + 1M + 0)",
    sum.body?.inventory?.valueMinor === 4_200_000,
    String(sum.body?.inventory?.valueMinor),
  );
  ok(
    "E2 the valuation totals.estimatedValueMinor === the summary total (one calculation, two surfaces)",
    val.body?.totals?.estimatedValueMinor === sum.body?.inventory?.valueMinor,
    `${val.body?.totals?.estimatedValueMinor} vs ${sum.body?.inventory?.valueMinor}`,
  );
  ok(
    "E3 the summary productCount counts INACTIVE products too (5 rows... 4 products)",
    sum.body?.inventory?.productCount === 4,
    String(sum.body?.inventory?.productCount),
  );

  console.log("\n[F] THE ZERO-COST HONESTY — present, counted, never crowned");
  const freeRow = (val.body?.rows ?? []).find((r: any) => r.id === pFree.body.id);
  ok("F1 Free Sample rides the valuation rows", !!freeRow, JSON.stringify(freeRow));
  ok(
    "F2 Free Sample: estimatedValueMinor 0 + ZERO_COST state (zero cost is valid, not an error)",
    freeRow?.estimatedValueMinor === 0 && freeRow?.costState === "ZERO_COST",
    JSON.stringify(freeRow),
  );

  console.log("\n[G] THE FLIP — the throne moves and the meta FOLLOWS");
  const flip = await api(jar, `/api/v1/products/${pAkar.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ costPriceMinor: 300_000 }),
  });
  ok("G1 Akar cost PATCH 200", flip.status === 200, String(flip.status));
  const sum2 = await api(jar, "/api/v1/reports/summary?days=30");
  ok(
    "G2 the throne FLIPPED to [Akar 3M, Bulk Screws 2M] — the fact rides the response, never cached",
    JSON.stringify(sum2.body?.inventory?.topValueProducts) ===
      JSON.stringify([
        { productId: pAkar.body.id, name: "Akar Widget", estimatedValueMinor: 3_000_000 },
        { productId: pBulk.body.id, name: "Bulk Screws", estimatedValueMinor: 2_000_000 },
      ]),
    JSON.stringify(sum2.body?.inventory?.topValueProducts),
  );
  const meta2 = await grounding(30);
  ok(
    "G3 THE READERS AGREE — meta.topStockProduct === the summary's rank 1 (id+name+value verbatim)",
    JSON.stringify(meta2.meta.topStockProduct) ===
      JSON.stringify({ id: pAkar.body.id, name: "Akar Widget", valueMinor: 3_000_000 }),
    `${JSON.stringify(meta2.meta.topStockProduct)}`,
  );
  ok(
    "G4 the snapshot prose cites the ranked throne (rank 1 name + pre-formatted value present)",
    Array.isArray(meta2.snapshot?.inventory?.topValueProducts) &&
      meta2.snapshot.inventory.topValueProducts[0]?.name === "Akar Widget" &&
      typeof meta2.snapshot.inventory.topValueProducts[0]?.estimatedValue === "string" &&
      meta2.snapshot.inventory.topValueProducts[0]?.rank === 1,
    JSON.stringify(meta2.snapshot?.inventory?.topValueProducts),
  );

  console.log("\n[H] THE ADDITIVE LAW");
  const invKeys = Object.keys(sum2.body.inventory).sort();
  ok(
    "H1 the inventory section grew EXACTLY one key (topValueProducts) over the R101 set",
    JSON.stringify(invKeys) ===
      JSON.stringify(["lowStockCount", "lowStockItems", "productCount", "topValueProducts", "valueMinor"]),
    JSON.stringify(invKeys),
  );
  const topKeys = Object.keys(sum2.body).sort();
  ok(
    "H2 the summary top-level key set is untouched",
    JSON.stringify(topKeys) ===
      JSON.stringify([
        "advancedAvailable",
        "expensesByCategory",
        "expensesByCategoryOther",
        "expensesByCategoryTotalMinor",
        "expensesCategoryCount",
        "inventory",
        "kpis",
        "outstanding",
        "range",
        "timeline",
        "topProducts",
      ]),
    JSON.stringify(topKeys),
  );
  ok(
    "H3 the system prompt carries the 6f law (ALL-TIME, never the window, zero-cost honesty)",
    /6f\. STOCK VALUE LEADERS/.test(meta2.systemPrompt) &&
      meta2.systemPrompt.includes("ALL-TIME fact about CURRENT stock"),
  );

  console.log("\n[I] 401 + FREE-plan honesty");
  const anon = await fetch(`${BASE}/api/v1/reports/summary?days=30`, { redirect: "manual" });
  ok("I1 the summary route rejects the unauthenticated (401)", anon.status === 401, String(anon.status));
  ok(
    "I2 the probe book rides FREE — advancedAvailable false (the chip's deep link needs NO entitlement)",
    sum2.body?.advancedAvailable === false,
    String(sum2.body?.advancedAvailable),
  );

  if (process.argv.includes("--keep")) {
    // Browser-QA mode: keep the seeded book + login. The password is printed
    // so the QA agent can sign in; sweep later with --cleanup.
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

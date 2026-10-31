/**
 * scripts/r98-merch-api-proofs.ts — R98 REAL-HTTP PROOFS (persists).
 *
 * Proves the BEST-SELLER tier end-to-end over live HTTP — the meta's
 * topProduct / topExpenseCategory (the copilot merch chips' existence
 * proof) against the seeded book and the summary route's own ranking:
 *
 *  [A] HONEST SILENCE — a fresh book: both meta fields are present-but-
 *      NULL (the chip gate reads falsy → hidden; no crash, no invented
 *      rank 1).
 *  [B] THE SEED (all through the API): products Akar Widget (2 sales:
 *      600k + 400k = 1M, 3 units) + Bahar Gadget (500k, 1 unit) + an
 *      unlinked line "Consulting" 300k; expenses Rent 200k ×2 + Utilities
 *      150k + Office 50k. meta.topProduct = { Akar Widget, 3 units, 1M }
 *      and meta.topExpenseCategory = { Rent, 400k } EXACT.
 *  [B2] THE READERS AGREE — the summary route's OWN topProducts[0] /
 *      expensesByCategory[0] === the meta's rank 1 (one authority across
 *      HTTP surfaces), and the snapshot's system prompt carries the 6e
 *      law over the wire.
 *  [C] THE WINDOW FLIP — a 2M Bahar Gadget sale dated 50 days back:
 *      days=30 keeps Akar Widget on top (the old sale is outside), days=90
 *      crowns Bahar Gadget 2.5M (the rank moves by the WINDOW, never by
 *      fiat) — and topExpenseCategory is window-immune here (Rent leads
 *      both windows).
 *  [D] THE MONEY FLIP — a Salaries expense 5M today → the cost throne
 *      moves to Salaries; the additive law holds throughout (meta.counts,
 *      largestDebtor/topDebtors intact, the snapshot's topProducts[0]
 *      UNTOUCHED as the same authority).
 *  [E] 401 — the summary route rejects the unauthenticated.
 *
 * Run: bun --conditions react-server scripts/r98-merch-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r98-merch-probe@qa.local";
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
      "x-forwarded-for": `10.225.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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

/** ISO datetime offset by whole days from NOW (issue/spend datetimes). */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
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
    data: { email: EMAIL, name: "R98 Merch Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R98 Merch Probe Co",
      slug: `r98-merch-probe-${Date.now().toString(36)}`,
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
  return { meta: g.meta as any, systemPrompt: g.systemPrompt };
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }
  await cleanup(); // defensive pre-sweep (fixed email → deterministic)

  const { user, business } = await seed();
  BIZ_ID = business.id;
  console.log(`probe business: ${BIZ_ID}`);

  const jar = await login(EMAIL);

  console.log("\n[A] HONEST SILENCE — a fresh book: both meta fields present-but-NULL");
  const metaEmpty = await grounding(30);
  ok("A1 meta.topProduct present-and-NULL on a fresh book (the chip gate reads falsy)",
    "topProduct" in metaEmpty.meta && metaEmpty.meta.topProduct === null,
    JSON.stringify(metaEmpty.meta.topProduct));
  ok("A2 meta.topExpenseCategory present-and-NULL too",
    "topExpenseCategory" in metaEmpty.meta && metaEmpty.meta.topExpenseCategory === null,
    JSON.stringify(metaEmpty.meta.topExpenseCategory));

  console.log("\n[B] THE SEED — every document through the API");
  const p1 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Akar Widget", salePriceMinor: 300_000, costPriceMinor: 100_000, stockQty: 100 }),
  });
  const p2 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Bahar Gadget", salePriceMinor: 500_000, costPriceMinor: 200_000, stockQty: 100 }),
  });
  ok("B0 two catalog products created", p1.status === 201 && p2.status === 201,
    `${p1.status}/${p2.status}`);
  const p1Id = p1.body.id as string;
  const p2Id = p2.body.id as string;

  // Sales: Akar Widget 600k(2) + 400k(1) = 1M/3u; Bahar Gadget 500k(1).
  const s1 = await api(jar, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: p1Id, name: "Akar Widget", qty: 2, unitPriceMinor: 300_000 }],
      issueDate: daysAgoIso(2),
    }),
  });
  const s2 = await api(jar, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: p1Id, name: "Akar Widget", qty: 1, unitPriceMinor: 400_000 }],
      issueDate: daysAgoIso(1),
    }),
  });
  const s3 = await api(jar, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [
        { productId: p2Id, name: "Bahar Gadget", qty: 1, unitPriceMinor: 500_000 },
        { name: "Consulting", qty: 1, unitPriceMinor: 300_000 },
      ],
      issueDate: daysAgoIso(1),
    }),
  });
  ok("B1 three sales issued", s1.status === 201 && s2.status === 201 && s3.status === 201,
    `${s1.status}/${s2.status}/${s3.status}`);

  // Expenses: Rent 200k ×2, Utilities 150k, Office 50k.
  const e1 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Rent", amountMinor: 200_000, spentAt: daysAgoIso(3) }),
  });
  const e2 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Rent", amountMinor: 200_000, spentAt: daysAgoIso(2) }),
  });
  const e3 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Utilities", amountMinor: 150_000, spentAt: daysAgoIso(2) }),
  });
  const e4 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Office", amountMinor: 50_000, spentAt: daysAgoIso(1) }),
  });
  ok("B2 four expenses recorded", e1.status === 201 && e2.status === 201 && e3.status === 201 && e4.status === 201,
    `${e1.status}/${e2.status}/${e3.status}/${e4.status}`);

  const seeded = await grounding(30);
  const tp = seeded.meta.topProduct;
  ok("B3 meta.topProduct EXACT = { Akar Widget, 3 units, 1,000,000, its productId } (the report's own rank 1; R153 — the drill id rides)",
    tp && tp.name === "Akar Widget" && tp.unitsSold === 3 && tp.revenueMinor === 1_000_000 && typeof tp.productId === "string" && tp.productId.length > 0,
    JSON.stringify(tp));
  ok("B4 the shape law — exactly 4 fields (R153 grew the drill id — additive)", tp && eq2(Object.keys(tp).sort(), ["name", "productId", "revenueMinor", "unitsSold"]));
  const tc = seeded.meta.topExpenseCategory;
  ok("B5 meta.topExpenseCategory EXACT = { Rent, 400,000 } (two entries folded by the report)",
    tc && tc.category === "Rent" && tc.totalMinor === 400_000,
    JSON.stringify(tc));
  ok("B6 the shape law — exactly 2 fields", tc && eq2(Object.keys(tc).sort(), ["category", "totalMinor"]));

  console.log("\n[B2] THE READERS AGREE — the summary route's OWN rank 1 === the meta");
  const sum = await api(jar, "/api/v1/reports/summary?days=30");
  ok("B2.1 summary 200", sum.status === 200, `got ${sum.status}`);
  const sumTop = sum.body?.topProducts?.[0];
  ok("B2.2 the summary route's topProducts[0] === meta.topProduct (one authority across surfaces)",
    sumTop && tp && sumTop.name === tp.name && sumTop.revenueMinor === tp.revenueMinor,
    `summary=${JSON.stringify(sumTop)} meta=${JSON.stringify(tp)}`);
  const sumCat = sum.body?.expensesByCategory?.[0];
  ok("B2.3 the summary route's expensesByCategory[0] === meta.topExpenseCategory",
    sumCat && tc && sumCat.category === tc.category && sumCat.totalMinor === tc.totalMinor,
    `summary=${JSON.stringify(sumCat)} meta=${JSON.stringify(tc)}`);
  ok("B2.4 the 6e prompt law rides the wire",
    seeded.systemPrompt.includes("6e. TOP PRODUCTS & EXPENSE CATEGORIES"));
  ok("B2.5 the snapshot text still cites the SAME lists (the sections law)",
    seeded.systemPrompt.includes('"topProducts"') && seeded.systemPrompt.includes('"expensesByCategory"'));

  console.log("\n[C] THE WINDOW FLIP — a 2M Bahar Gadget sale 50 days back");
  const s4 = await api(jar, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: p2Id, name: "Bahar Gadget", qty: 1, unitPriceMinor: 2_000_000 }],
      issueDate: daysAgoIso(50),
    }),
  });
  ok("C0 the back-dated sale issued", s4.status === 201, `got ${s4.status}`);
  const m30 = (await grounding(30)).meta;
  const m90 = (await grounding(90)).meta;
  ok("C1 days=30 → the rank 1 stays Akar Widget 1M (the old sale is OUTSIDE the window)",
    m30.topProduct && m30.topProduct.name === "Akar Widget" && m30.topProduct.revenueMinor === 1_000_000,
    JSON.stringify(m30.topProduct));
  ok("C2 days=90 → the throne moves to Bahar Gadget 2.5M/2u (the rank follows the WINDOW)",
    m90.topProduct && m90.topProduct.name === "Bahar Gadget" && m90.topProduct.revenueMinor === 2_500_000 && m90.topProduct.unitsSold === 2,
    JSON.stringify(m90.topProduct));
  ok("C3 the cost rank is window-immune here (Rent leads both 30d and 90d)",
    m30.topExpenseCategory?.category === "Rent" && m90.topExpenseCategory?.category === "Rent");

  console.log("\n[D] THE MONEY FLIP — Salaries 5M today");
  const e5 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Salaries", amountMinor: 5_000_000, spentAt: daysAgoIso(0) }),
  });
  ok("D0 the big expense recorded", e5.status === 201, `got ${e5.status}`);
  const flipped = await grounding(30);
  ok("D1 the cost throne moves to Salaries 5M (by money, never by fiat)",
    flipped.meta.topExpenseCategory?.category === "Salaries" && flipped.meta.topExpenseCategory?.totalMinor === 5_000_000,
    JSON.stringify(flipped.meta.topExpenseCategory));
  ok("D2 the ADDITIVE law — meta.counts intact (WINDOWED: 3 sales in the 30d window — the 50d-back sale is honestly outside — and 5 expenses)",
    flipped.meta.counts && flipped.meta.counts.sales === 3 && flipped.meta.counts.expenses === 5,
    JSON.stringify({ sales: flipped.meta.counts?.sales, expenses: flipped.meta.counts?.expenses }));
  ok("D3 the ADDITIVE law — the CURRENT leader fields still present [RE-PINNED R169: the R147 drill renamed/reshaped the meta's leader fields to the singular topDebtor/topCreditor; the batteries could not run in-process since birth — the server-only chain — so the drift went stale-unnoticed; the R169 react-server runner un-froze them]",
    "topDebtor" in flipped.meta && "topCreditor" in flipped.meta);
  ok("D4 the ADDITIVE law — the CURRENT attribution family still present [R169 re-pin: the R91/R92 fields left the meta in a later round]",
    "topProduct" in flipped.meta && "topExpenseCategory" in flipped.meta &&
    "topStockProduct" in flipped.meta && "topStockRunnerUp" in flipped.meta);
  ok("D5 the meta's own merch fields carry the R98 law (topStockProduct/topStockRunnerUp present; topProduct shaped) — the throne facts the chips cite",
    flipped.meta.topStockProduct !== undefined && flipped.meta.topStockRunnerUp !== undefined &&
    (flipped.meta.topProduct === null || typeof flipped.meta.topProduct === "object"));

  console.log("\n[E] 401 — the unauthenticated are rejected");
  const anon = await fetch(`${BASE}/api/v1/reports/summary?days=30`, { redirect: "manual" });
  ok("E1 summary 401 for the unauthenticated", anon.status === 401, `got ${anon.status}`);

  console.log(`\n=== r98-merch-api-proofs: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:", failures.join(" | "));
    if (!process.argv.includes("--keep")) await cleanup();
    process.exit(1);
  }
}

function eq2(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

await main();
await db.$disconnect();
if (!process.argv.includes("--keep")) {
  await cleanup();
  console.log("probe swept (run with --keep to preserve for browser QA)");
}

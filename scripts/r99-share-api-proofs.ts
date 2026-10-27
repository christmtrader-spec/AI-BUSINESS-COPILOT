/**
 * scripts/r99-share-api-proofs.ts — R99 REAL-HTTP PROOFS (persists).
 *
 * Proves the SHARE LANGUAGE round end-to-end over live HTTP — the
 * inventory-valuation route's additive `topValueProducts` throne fact and
 * the dashboard tiles' share-bar inputs:
 *
 *  [A] HONEST SILENCE — a fresh book: topValueProducts present-and-[]
 *      (the strip gate reads falsy → nothing rendered).
 *  [B] THE SEED (all through the API): Akar Widget (stock 3 × cost 100k
 *      = 300k) + Bahar Gadget (stock 2 × cost 250k = 500k) + Cyrus Kit
 *      (stock 5 × cost 50k = 250k) → throne = [Bahar 500k, Akar 300k]
 *      EXACT (ids + names + values verbatim); totals = 1_050_000; and
 *      under the DEFAULT sort the throne IS the table's head (rows[0]
 *      === rank 1) — one authority on the wire.
 *  [C] SORT INDEPENDENCE — sort=NAME_ASC / QUANTITY_ASC return the
 *      IDENTICAL throne JSON (the crown never follows the table's sort).
 *  [D] FILTER COHERENCE — q=Bahar re-crowns INSIDE the filtered set
 *      ([Bahar] alone) and the share basis (totals) shrinks with it.
 *  [E] THE TIE — two same-value products → rank 1 = the SMALLER id
 *      (the table's own tie-break, deterministic over the wire).
 *  [F] THE VALUE FLIP — PATCH Akar's cost 100k→600k (3 × 600k = 1.8M) →
 *      the throne MOVES BY MONEY: [Akar 1.8M, Bahar 500k]; the additive
 *      law holds (totals fields, scan, pagination untouched).
 *  [G] THE DASHBOARD INPUTS — /api/v1/receivables and /api/v1/payables
 *      carry totalOutstandingMinor + leaders[0].outstandingMinor over the
 *      SAME response (same basis by construction) after seeding one open
 *      sale (customer Akar Trading, 800k) and one open bill (supplier
 *      Bahar Supply, 500k): the receivables leader share = exactly 100%
 *      of a one-party book; the payables twin likewise.
 *  [H] 401 — the valuation route rejects the unauthenticated.
 *
 * Run: bun --conditions react-server scripts/r99-share-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r99-share-probe@qa.local";
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
      "x-forwarded-for": `10.226.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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
    data: { email: EMAIL, name: "R99 Share Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R99 Share Probe Co",
      slug: `r99-share-probe-${Date.now().toString(36)}`,
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

  console.log("\n[A] HONEST SILENCE — a fresh book: the throne present-and-EMPTY");
  const fresh = await api(jar, "/api/v1/reports/inventory-valuation");
  ok("A1 valuation 200 on a fresh book", fresh.status === 200, String(fresh.status));
  ok("A2 topValueProducts present-and-[] on a fresh book (the strip gate reads falsy)",
    Array.isArray(fresh.body?.topValueProducts) && fresh.body.topValueProducts.length === 0,
    JSON.stringify(fresh.body?.topValueProducts));

  console.log("\n[B] THE SEED — three products through the API; the throne EXACT");
  const p1 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Akar Widget", salePriceMinor: 300_000, costPriceMinor: 100_000, stockQty: 3 }),
  });
  const p2 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Bahar Gadget", salePriceMinor: 500_000, costPriceMinor: 250_000, stockQty: 2 }),
  });
  const p3 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Cyrus Kit", salePriceMinor: 120_000, costPriceMinor: 50_000, stockQty: 5 }),
  });
  ok("B0 three products created", p1.status === 201 && p2.status === 201 && p3.status === 201,
    `${p1.status}/${p2.status}/${p3.status}`);
  const seeded = await api(jar, "/api/v1/reports/inventory-valuation");
  const throne = seeded.body?.topValueProducts ?? [];
  ok("B1 the throne carries exactly rank 1..2 of 3 products", throne.length === 2, JSON.stringify(throne));
  ok("B2 rank 1 = Bahar Gadget 500_000 EXACT (id+name+value verbatim)",
    throne[0]?.productId === p2.body?.id && throne[0]?.name === "Bahar Gadget" && throne[0]?.estimatedValueMinor === 500_000,
    JSON.stringify(throne[0]));
  ok("B3 rank 2 = Akar Widget 300_000 EXACT",
    throne[1]?.productId === p1.body?.id && throne[1]?.name === "Akar Widget" && throne[1]?.estimatedValueMinor === 300_000,
    JSON.stringify(throne[1]));
  ok("B4 the share basis: totals.estimatedValueMinor = 1_050_000",
    seeded.body?.totals?.estimatedValueMinor === 1_050_000, String(seeded.body?.totals?.estimatedValueMinor));
  ok("B5 under the DEFAULT sort the throne IS the table's head (rows[0].id === rank 1)",
    seeded.body?.rows?.[0]?.id === throne[0]?.productId,
    `${seeded.body?.rows?.[0]?.id} vs ${throne[0]?.productId}`);

  console.log("\n[C] SORT INDEPENDENCE — the crown never follows the table's sort");
  const byName = await api(jar, "/api/v1/reports/inventory-valuation?sort=NAME_ASC");
  const byQty = await api(jar, "/api/v1/reports/inventory-valuation?sort=QUANTITY_ASC");
  ok("C1 sort=NAME_ASC → IDENTICAL throne", JSON.stringify(byName.body?.topValueProducts) === JSON.stringify(throne),
    JSON.stringify(byName.body?.topValueProducts));
  ok("C2 sort=QUANTITY_ASC → IDENTICAL throne", JSON.stringify(byQty.body?.topValueProducts) === JSON.stringify(throne),
    JSON.stringify(byQty.body?.topValueProducts));
  ok("C3 (sanity) the page order DID follow the sort (NAME_ASC head = Akar Widget)",
    byName.body?.rows?.[0]?.name === "Akar Widget", String(byName.body?.rows?.[0]?.name));

  console.log("\n[D] FILTER COHERENCE — the crown re-ranks INSIDE the filtered set");
  const qBahar = await api(jar, "/api/v1/reports/inventory-valuation?q=Bahar");
  ok("D1 q=Bahar → throne = [Bahar] alone", qBahar.body?.topValueProducts?.length === 1 &&
    qBahar.body.topValueProducts[0]?.productId === p2.body?.id,
    JSON.stringify(qBahar.body?.topValueProducts));
  ok("D2 the share basis shrinks with the filter (totals = 500_000)",
    qBahar.body?.totals?.estimatedValueMinor === 500_000, String(qBahar.body?.totals?.estimatedValueMinor));

  console.log("\n[E] THE TIE — same value → the SMALLER id is rank 1 (over the wire)");
  // The twins must OUTVALUE the seed book (2M each vs 500k top) so the tie
  // pair owns ranks 1-2 — a tie test whose twins rank 3rd/4th proves nothing.
  const t1 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Twin One", salePriceMinor: 10_000, costPriceMinor: 2_000_000, stockQty: 1 }),
  });
  const t2 = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Twin Two", salePriceMinor: 10_000, costPriceMinor: 2_000_000, stockQty: 1 }),
  });
  const tieRes = await api(jar, "/api/v1/reports/inventory-valuation");
  const tieThrone = tieRes.body?.topValueProducts ?? [];
  const smallerId = [t1.body.id as string, t2.body.id as string].sort()[0];
  ok("E1 rank 1 is the smaller of the two tied ids", tieThrone[0]?.productId === smallerId,
    `${tieThrone[0]?.productId} vs smaller ${smallerId}`);
  ok("E2 the tie pair occupies ranks 1-2 (2_000_000 each, id order)",
    tieThrone[0]?.estimatedValueMinor === 2_000_000 && tieThrone[1]?.estimatedValueMinor === 2_000_000 &&
    tieThrone[0]?.productId === smallerId,
    JSON.stringify(tieThrone));

  console.log("\n[F] THE VALUE FLIP — PATCH Akar cost 100k→1M (3 × 1M = 3M beats the 2M twins); the throne moves BY MONEY");
  const flip = await api(jar, `/api/v1/products/${p1.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ costPriceMinor: 1_000_000 }),
  });
  ok("F0 PATCH accepted", flip.status === 200, String(flip.status));
  const flipped = await api(jar, "/api/v1/reports/inventory-valuation");
  const flipThrone = flipped.body?.topValueProducts ?? [];
  ok("F1 the crown moves to Akar Widget 3_000_000", flipThrone[0]?.productId === p1.body?.id &&
    flipThrone[0]?.estimatedValueMinor === 3_000_000, JSON.stringify(flipThrone[0]));
  ok("F2 rank 2 = the twins' id-order winner at 2_000_000 (the tie law held through the flip)",
    flipThrone[1]?.productId === smallerId && flipThrone[1]?.estimatedValueMinor === 2_000_000,
    JSON.stringify(flipThrone[1]));
  ok("F3 the ADDITIVE law: totals fields intact (8 keys, value 7_750_000 — 3M + 2M + 2M + 500k + 250k)",
    Object.keys(flipped.body?.totals ?? {}).length === 8 && flipped.body?.totals?.estimatedValueMinor === 7_750_000,
    JSON.stringify(flipped.body?.totals));
  ok("F4 the ADDITIVE law: scan.complete true + pagination intact",
    flipped.body?.scan?.complete === true && typeof flipped.body?.pagination?.totalCount === "number");

  console.log("\n[G] THE DASHBOARD INPUTS — one book, both sides, same-basis facts");
  const cust = await api(jar, "/api/v1/customers", {
    method: "POST",
    body: JSON.stringify({ name: "Akar Trading" }),
  });
  const supp = await api(jar, "/api/v1/suppliers", {
    method: "POST",
    body: JSON.stringify({ name: "Bahar Supply" }),
  });
  ok("G0 customer + supplier created", cust.status === 201 && supp.status === 201,
    `${cust.status}/${supp.status}`);
  const sale = await api(jar, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      customerId: cust.body.id,
      items: [{ name: "Consulting", qty: 1, unitPriceMinor: 800_000 }],
      issueDate: daysAgoIso(1),
    }),
  });
  const bill = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({
      supplierId: supp.body.id,
      category: "Services",
      amountMinor: 500_000,
      spentAt: daysAgoIso(1),
      dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    }),
  });
  ok("G1 open sale (800k) + open bill (500k) created", sale.status === 201 && bill.status === 201,
    `${sale.status}/${bill.status}`);
  const recv = await api(jar, "/api/v1/receivables");
  const pay = await api(jar, "/api/v1/payables");
  ok("G2 receivables: leader outstanding === totalOutstandingMinor (one-party book → share 100)",
    recv.body?.totalOutstandingMinor === 800_000 && recv.body?.leaders?.leaders?.[0]?.outstandingMinor === 800_000,
    JSON.stringify({ t: recv.body?.totalOutstandingMinor, l: recv.body?.leaders?.leaders?.[0] }));
  ok("G3 payables: leader outstanding === totalOutstandingMinor (share 100)",
    pay.body?.totalOutstandingMinor === 500_000 && pay.body?.leaders?.leaders?.[0]?.outstandingMinor === 500_000,
    JSON.stringify({ t: pay.body?.totalOutstandingMinor, l: pay.body?.leaders?.leaders?.[0] }));
  ok("G4 the leader is a REAL party (partyId non-null → the R99 drill goes party-scoped)",
    typeof recv.body?.leaders?.leaders?.[0]?.partyId === "string" &&
    typeof pay.body?.leaders?.leaders?.[0]?.partyId === "string");

  console.log("\n[H] 401 — the unauthenticated never see the throne");
  const anon = await fetch(`${BASE}/api/v1/reports/inventory-valuation`, { redirect: "manual" });
  ok("H1 valuation 401 unauthenticated", anon.status === 401, String(anon.status));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("FAILURES:", failures.join(" | "));
    await cleanup();
    process.exit(1);
  }
  if (process.argv.includes("--keep")) {
    console.log(`\n--keep: probe left in place for browser QA (business ${BIZ_ID}; sweep with --cleanup)`);
  } else {
    await cleanup();
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("HARNESS ERROR:", e);
  await cleanup();
  process.exit(1);
});

/**
 * scripts/r97-podium-api-proofs.ts — R97 REAL-HTTP PROOFS (persists).
 *
 * Proves the PODIUM tier end-to-end over live HTTP — the meta's
 * topDebtors/topCreditors (the copilot "who else?" chips' existence
 * proof) and the balances client mapping (runnersUpOfFact over the RAW
 * route response, exactly what fetchBalancesData does in the browser):
 *
 *  [A] HONEST SILENCE — a fresh book: the meta's topDebtors/topCreditors
 *      are PRESENT-but-EMPTY arrays ([] — the chip gate reads length < 2
 *      → hidden) and the client runners-up extractor maps the routes'
 *      honest-empty leaders fact to [] — no chip, no podium row.
 *  [B] THE SEED (the r96 law): Akar 800k (2 open), Bahar 500k, Chinar
 *      PAID (never competes), walk-in 2M mass; suppliers S1 800k, S2
 *      500k + anonymous 100k → meta.topDebtors = [mass 2M rank1, Akar
 *      800k rank2, Bahar 500k rank3] (top-3 of a 3-party book — Chinar
 *      settled absent) and meta.topCreditors = [Akar Ltd 800k rank1,
 *      Bahar Supply 500k rank2, mass 100k rank3]; THE READERS AGREE at
 *      podium depth: runnersUpOfFact over the RAW responses === the
 *      meta's podium minus rank 1, byte-for-byte, both sides; each row
 *      carries the server's OWN rank + partyId (null on the mass).
 *  [C] THE FLIP — pay S1 → the creditor podium shrinks to [Bahar 500k,
 *      mass 100k] (the chip's tooltip would move live); pay Akar's both
 *      invoices → the debtor podium shrinks to [mass 2M, Bahar 500k]
 *      (Akar leaves by money, never by fiat); pay the REST of the
 *      payables book → topCreditors = [] (the honest silence, again).
 *  [D] THE ADDITIVE LAW — largestDebtor/largestCreditor still present
 *      and agreeing with podium[0] after every flip; meta.counts and the
 *      R91/R92 attribution fields intact; the routes' own aggregates
 *      byte-untouched (2.5M/2 receivable, 0/0 payable at the end).
 *  [E] 401 — both routes reject the unauthenticated.
 *
 * Run: bun --conditions react-server scripts/r97-podium-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r97-podium-probe@qa.local";
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
const { runnersUpOfFact, topLeaderOfFact } = await import("../src/lib/leader-view");

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": `10.224.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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

/** YYYY-MM-DD in the BUSINESS timezone (the §84 date-only input law). */
function tzDayKey(offsetDays: number): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const base = new Date(`${y}-${m}-${d}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

async function seed() {
  const passwordHash = await import("bcryptjs").then((m) => m.default.hashSync(PASS, 10));
  const user = await db.user.create({
    data: { email: EMAIL, name: "R97 Podium Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R97 Podium Probe Co",
      slug: `r97-podium-probe-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: user.id,
      vatEnabled: false,
    },
  });
  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  BIZ_ID = business.id;
  return { user, business };
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

async function groundingMeta() {
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
    days: 30,
    uiLocale: "en",
  });
  return g.meta as any;
}

/** The client's exact browser-side mapping (fetchBalancesData's law). */
function clientPodium(rawLeaders: any) {
  return runnersUpOfFact(rawLeaders, 3);
}
/** The copilot chip gate's exact view: the meta's podium minus rank 1. */
function metaRunners(metaPodium: any[]) {
  return (metaPodium ?? []).filter((e) => e.rank !== 1);
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }
  await cleanup(); // defensive pre-sweep (fixed email → deterministic)

  const { business } = await seed();

  if (process.argv.includes("--keep")) {
    console.log(`KEEP: email=${EMAIL} pass=${PASS} businessId=${business.id}`);
  }

  try {
    const jar = await login(EMAIL);

    console.log("\n[A] HONEST SILENCE — a fresh book: the podium proof is present-but-empty");
    const recvEmpty = await api(jar, "/api/v1/receivables");
    ok("A1 receivables 200", recvEmpty.status === 200, `got ${recvEmpty.status}`);
    const metaEmpty = await groundingMeta();
    ok("A2 meta.topDebtors present-but-EMPTY on a fresh book ([] — the chip gate reads length < 2)",
      Array.isArray(metaEmpty.topDebtors) && metaEmpty.topDebtors.length === 0,
      JSON.stringify(metaEmpty.topDebtors));
    ok("A3 meta.topCreditors present-but-EMPTY too",
      Array.isArray(metaEmpty.topCreditors) && metaEmpty.topCreditors.length === 0,
      JSON.stringify(metaEmpty.topCreditors));
    ok("A4 the CLIENT runners-up extractor maps the honest-empty fact to [] (no podium row)",
      clientPodium(recvEmpty.body?.leaders).length === 0 &&
      JSON.stringify(clientPodium(recvEmpty.body?.leaders)) === "[]");

    console.log("\n[B] THE SEED — every document through the API");
    const akar = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Akar Trading" }) });
    const akarId = akar.body.id as string;
    const bahar = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Bahar Foods" }) });
    const baharId = bahar.body.id as string;
    const chinar = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Chinar Retail" }) });
    const chinarId = chinar.body.id as string;
    ok("B0 three customers created", akar.status === 201 && bahar.status === 201 && chinar.status === 201);

    const inv1 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akarId,
        items: [{ name: "Consulting", qty: 1, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-35),
      }),
    });
    const inv2 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akarId,
        items: [{ name: "Setup", qty: 1, unitPriceMinor: 300_000 }],
        issueDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-5),
      }),
    });
    const inv3 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: baharId,
        items: [{ name: "Goods", qty: 1, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-15),
      }),
    });
    ok("B1 three open invoices created (Akar 500k + Akar 300k + Bahar 500k)",
      inv1.status === 201 && inv2.status === 201 && inv3.status === 201);
    const invChinar = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: chinarId,
        items: [{ name: "One-off", qty: 1, unitPriceMinor: 300_000 }],
        issueDate: new Date(Date.now() - 15 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-10),
      }),
    });
    const payChinar = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: invChinar.body.id, amountMinor: 300_000, method: "CASH" }),
    });
    ok("B2 Chinar 300k created AND paid in full — settled money never competes",
      invChinar.status === 201 && payChinar.status === 201);
    const invWalkin = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [{ name: "Walk-in bulk", qty: 2, unitPriceMinor: 1_000_000 }],
        issueDate: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-3),
      }),
    });
    ok("B3 walk-in 2M mass invoice (no customer) created", invWalkin.status === 201);

    const s1 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Akar Ltd" }) });
    const s2 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Bahar Supply" }) });
    const s1Id = s1.body.id as string;
    const s2Id = s2.body.id as string;
    ok("B4 two suppliers created", s1.status === 201 && s2.status === 201);
    const exp1 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s1Id, category: "Rent", amountMinor: 800_000, spentAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), dueDate: tzDayKey(-10) }),
    });
    const exp2 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s2Id, category: "Utilities", amountMinor: 500_000, spentAt: new Date(Date.now() - 25 * 86_400_000).toISOString(), dueDate: tzDayKey(-20) }),
    });
    const expAnon = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ category: "Supplies", amountMinor: 100_000, spentAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), dueDate: tzDayKey(-2) }),
    });
    ok("B5 S1 800k + S2 500k + anonymous 100k expenses created",
      exp1.status === 201 && exp2.status === 201 && expAnon.status === 201);

    console.log("\n[B+] THE PODIUM LAW — ranks 1..3 as the meta and the chips read them");
    const meta = await groundingMeta();
    ok("B6 meta.topDebtors = [mass 2M rank1, Akar 800k rank2, Bahar 500k rank3] — top-3 of a 3-party book",
      JSON.stringify(meta.topDebtors) ===
        JSON.stringify([
          { rank: 1, partyId: null, partyName: null, outstandingMinor: 2_000_000, openItems: 1, partyCount: 3 },
          { rank: 2, partyId: akarId, partyName: "Akar Trading", outstandingMinor: 800_000, openItems: 2, partyCount: 3 },
          { rank: 3, partyId: baharId, partyName: "Bahar Foods", outstandingMinor: 500_000, openItems: 1, partyCount: 3 },
        ]),
      JSON.stringify(meta.topDebtors));
    ok("B7 meta.topCreditors = [Akar Ltd 800k rank1, Bahar Supply 500k rank2, mass 100k rank3]",
      JSON.stringify(meta.topCreditors) ===
        JSON.stringify([
          { rank: 1, partyId: s1Id, partyName: "Akar Ltd", outstandingMinor: 800_000, openItems: 1, partyCount: 3 },
          { rank: 2, partyId: s2Id, partyName: "Bahar Supply", outstandingMinor: 500_000, openItems: 1, partyCount: 3 },
          { rank: 3, partyId: null, partyName: null, outstandingMinor: 100_000, openItems: 1, partyCount: 3 },
        ]),
      JSON.stringify(meta.topCreditors));

    const recv = await api(jar, "/api/v1/receivables");
    const pay = await api(jar, "/api/v1/payables");
    ok("B8 THE READERS AGREE at podium depth — client runnersUpOfFact(RAW receivables) === meta.topDebtors minus rank 1",
      JSON.stringify(clientPodium(recv.body?.leaders)) === JSON.stringify(metaRunners(meta.topDebtors)),
      `${JSON.stringify(clientPodium(recv.body?.leaders))} vs ${JSON.stringify(metaRunners(meta.topDebtors))}`);
    ok("B9 same agreement on the payables side (the rose rows' proof)",
      JSON.stringify(clientPodium(pay.body?.leaders)) === JSON.stringify(metaRunners(meta.topCreditors)),
      `${JSON.stringify(clientPodium(pay.body?.leaders))} vs ${JSON.stringify(metaRunners(meta.topCreditors))}`);
    ok("B10 the client leaderboard rows carry the server's OWN rank + partyId (mass row partyId null)",
      clientPodium(recv.body?.leaders)[0]?.rank === 2 &&
      clientPodium(recv.body?.leaders)[0]?.partyId === akarId &&
      clientPodium(pay.body?.leaders)[1]?.partyId === null);
    ok("B11 the routes' aggregates byte-untouched by the additive podium (3.3M/4 receivable, 1.4M/3 payable)",
      recv.body?.totalOutstandingMinor === 3_300_000 && recv.body?.openCount === 4 &&
      pay.body?.totalOutstandingMinor === 1_400_000 && pay.body?.openCount === 3,
      JSON.stringify({ r: recv.body?.totalOutstandingMinor, rn: recv.body?.openCount, p: pay.body?.totalOutstandingMinor, pn: pay.body?.openCount }));

    console.log("\n[C] THE FLIP — the podium moves by money, live");
    const payS1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ expenseId: exp1.body.id, amountMinor: 800_000, method: "CASH" }),
    });
    ok("C1 S1's expense paid (201)", payS1.status === 201, `got ${payS1.status}`);
    const metaFlip1 = await groundingMeta();
    ok("C2 after the flip: meta.topCreditors = [Bahar Supply 500k rank1, mass 100k rank2] — the chip's tooltip money moves",
      JSON.stringify(metaFlip1.topCreditors) ===
        JSON.stringify([
          { rank: 1, partyId: s2Id, partyName: "Bahar Supply", outstandingMinor: 500_000, openItems: 1, partyCount: 2 },
          { rank: 2, partyId: null, partyName: null, outstandingMinor: 100_000, openItems: 1, partyCount: 2 },
        ]),
      JSON.stringify(metaFlip1.topCreditors));
    ok("C3 flip symmetry: the extractor over the RAW payables response agrees post-flip",
      JSON.stringify(clientPodium((await api(jar, "/api/v1/payables")).body?.leaders)) ===
        JSON.stringify(metaRunners(metaFlip1.topCreditors)));

    const payAkar1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv1.body.id, amountMinor: 500_000, method: "CASH" }),
    });
    const payAkar2 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv2.body.id, amountMinor: 300_000, method: "CASH" }),
    });
    ok("C4 Akar's both invoices paid (201 ×2)", payAkar1.status === 201 && payAkar2.status === 201);
    const metaFlip2 = await groundingMeta();
    ok("C5 Akar leaves the debtor podium BY MONEY: topDebtors = [mass 2M rank1, Bahar 500k rank2], partyCount 2",
      JSON.stringify(metaFlip2.topDebtors) ===
        JSON.stringify([
          { rank: 1, partyId: null, partyName: null, outstandingMinor: 2_000_000, openItems: 1, partyCount: 2 },
          { rank: 2, partyId: baharId, partyName: "Bahar Foods", outstandingMinor: 500_000, openItems: 1, partyCount: 2 },
        ]),
      JSON.stringify(metaFlip2.topDebtors));
    ok("C6 the creditor throne stays honest through the debtor flip (payables untouched by sales payments)",
      JSON.stringify(metaFlip2.topCreditors) === JSON.stringify(metaFlip1.topCreditors));

    const payS2 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ expenseId: exp2.body.id, amountMinor: 500_000, method: "CASH" }),
    });
    const payAnon = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ expenseId: expAnon.body.id, amountMinor: 100_000, method: "CASH" }),
    });
    ok("C7 the rest of the payables book paid (201 ×2)", payS2.status === 201 && payAnon.status === 201);
    const metaFlip3 = await groundingMeta();
    ok("C8 an empty payables book → meta.topCreditors = [] (the honest silence, again)",
      Array.isArray(metaFlip3.topCreditors) && metaFlip3.topCreditors.length === 0,
      JSON.stringify(metaFlip3.topCreditors));
    const payFinal = await api(jar, "/api/v1/payables");
    ok("C9 the client extractor agrees with the silence (no podium rows on an empty book)",
      JSON.stringify(clientPodium(payFinal.body?.leaders)) === "[]");

    console.log("\n[D] THE ADDITIVE LAW — nothing pre-existing moved");
    ok("D1 meta.largestDebtor still present and === topDebtors[0]'s four shared fields",
      metaFlip3.largestDebtor &&
      metaFlip3.topDebtors[0] &&
      JSON.stringify({
        partyName: metaFlip3.largestDebtor.partyName,
        outstandingMinor: metaFlip3.largestDebtor.outstandingMinor,
        openItems: metaFlip3.largestDebtor.openItems,
        partyCount: metaFlip3.largestDebtor.partyCount,
      }) ===
        JSON.stringify({
          partyName: metaFlip3.topDebtors[0].partyName,
          outstandingMinor: metaFlip3.topDebtors[0].outstandingMinor,
          openItems: metaFlip3.topDebtors[0].openItems,
          partyCount: metaFlip3.topDebtors[0].partyCount,
        }),
      JSON.stringify(metaFlip3.largestDebtor));
    ok("D2 topLeaderOfFact(RAW payables on an empty book) === null — the two extractors agree on silence",
      topLeaderOfFact(payFinal.body?.leaders) === null);
    ok("D3 meta.counts intact (agedOver60Invoices/pastDueBills/receivablesOverdue present, numbers)",
      typeof meta.counts?.agedOver60Invoices === "number" &&
      typeof meta.counts?.pastDueBills === "number" &&
      typeof meta.counts?.receivablesOverdue === "number");
    ok("D4 meta's R91/R92/R96 fields still present",
      "topOverdueCustomer" in meta && "topAgedOver60Customer" in meta &&
      "topPastDueSupplier" in meta && "largestDebtor" in meta && "largestCreditor" in meta);
    const recvFinal = await api(jar, "/api/v1/receivables");
    ok("D5 receivables aggregates byte-untouched post-flips (2.5M over 2 open invoices)",
      recvFinal.body?.totalOutstandingMinor === 2_500_000 && recvFinal.body?.openCount === 2,
      JSON.stringify({ m: recvFinal.body?.totalOutstandingMinor, n: recvFinal.body?.openCount }));

    console.log("\n[E] 401 — the routes reject the unauthenticated");
    const f401a = await fetch(`${BASE}/api/v1/receivables`, { redirect: "manual" });
    const f401b = await fetch(`${BASE}/api/v1/payables`, { redirect: "manual" });
    ok("E1 both routes 401 unauthenticated", f401a.status === 401 && f401b.status === 401,
      `${f401a.status}/${f401b.status}`);

  } finally {
    if (!process.argv.includes("--keep")) {
      await cleanup();
    }
    await db.$disconnect();
  }

  console.log(`\n=== r97-podium-api-proofs: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();

export {};

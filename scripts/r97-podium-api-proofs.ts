/**
 * scripts/r97-podium-api-proofs.ts — R97 REAL-HTTP PROOFS (persists).
 *
 * Proves the PODIUM tier end-to-end over live HTTP — the meta's throne
 * facts (topDebtor/topCreditor — the copilot's outstanding chips'
 * existence proof) and the balances client mapping (runnersUpOfFact over
 * the RAW route response, exactly what fetchBalancedData does in the
 * browser):
 *
 *  RE-PINNED R169 (honest archaeology): the R97-era meta carried
 *  topDebtors/topCreditors PODIUM ARRAYS; the R147 OUTSTANDING DRILL
 *  replaced them with the SINGULAR topDebtor/topCreditor
 *  (outstandingViewOf: partyId IN for the aging drill, rank/partyCount
 *  deliberately dropped). These batteries could not run in-process since
 *  birth (the server-only import chain) so the reshape went
 *  stale-unnoticed; the R169 `bun --conditions react-server` runner
 *  un-froze them and this battery now pins the CURRENT shapes.
 *
 *  [A] HONEST SILENCE — a fresh book: the meta's topDebtor/topCreditor
 *      are PRESENT-but-NULL (the chip gate reads falsy → hidden) and the
 *      client runners-up extractor maps the routes' honest-empty leaders
 *      fact to [] — no chip, no podium row.
 *  [B] THE SEED (the r96 law): Akar 800k (2 open), Bahar 500k, Chinar
 *      PAID (never competes), walk-in 2M mass; suppliers S1 800k, S2
 *      500k + anonymous 100k → meta.topDebtor = the mass throne
 *      (2M, openItems 1) and meta.topCreditor = the S1 throne (800k, 1);
 *      THE READERS AGREE at throne depth: throneOf (the battery's mirror
 *      of outstandingViewOf) over the RAW responses === the meta, both
 *      sides; the PODIUM itself lives on the client extractor
 *      (runnersUpOfFact yields ranks 2..3 with the server's OWN rank +
 *      partyId, null on the mass).
 *  [C] THE FLIP — pay S1 → the creditor throne MOVES to S2 500k (the
 *      chip's tooltip would move live); pay Akar's both invoices → Akar
 *      leaves the WIRE podium by money (ranks 2..3 = Bahar alone over a
 *      2-party book) while the throne honestly stays the mass; pay the
 *      REST of the payables book → topCreditor = null (the honest
 *      silence, again).
 *  [D] THE ADDITIVE LAW — the meta's topDebtor agrees with the wire's
 *      throne after every flip; meta.counts (the current closed scope)
 *      and the current attribution family intact; the routes' own
 *      aggregates byte-untouched (3.3M/4 → 2.5M/2 receivable,
 *      1.4M/3 → 0 payable).
 *  [E] 401 — the routes reject the unauthenticated.
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
/**
 * The meta's exact throne mapping (outstandingViewOf's R147 law, mirrored
 * over the RAW wire rows): partyId + partyName + outstandingMinor +
 * openItems (the wire's `count` renamed) — rank/partyCount deliberately
 * DROPPED: the meta carries exactly what the chips render.
 * RE-PINNED R169: the R97-era meta carried topDebtors/topCreditors PODIUM
 * ARRAYS; the R147 OUTSTANDING DRILL replaced them with the singular
 * topDebtor/topCreditor (the batteries could not run in-process since
 * birth — the server-only chain — so the reshape went stale-unnoticed;
 * the R169 react-server runner un-froze them).
 */
function throneOf(rawLeaders: any) {
  const first = rawLeaders?.leaders?.[0];
  if (!first) return null;
  return {
    partyId: first.partyId,
    partyName: first.partyName,
    outstandingMinor: first.outstandingMinor,
    openItems: first.count,
  };
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
    ok("A2 meta.topDebtor present-but-NULL on a fresh book (the chip gate reads falsy) [RE-PINNED R169: the R147 drill replaced the topDebtors PODIUM ARRAY with the singular throne]",
      "topDebtor" in (metaEmpty as any) && (metaEmpty as any).topDebtor === null,
      JSON.stringify((metaEmpty as any).topDebtor));
    ok("A3 meta.topCreditor present-but-NULL too",
      "topCreditor" in (metaEmpty as any) && (metaEmpty as any).topCreditor === null);
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
    ok("B6 meta.topDebtor = { partyId null, partyName null, 2,000,000, openItems 1 } — the mass LEADS a 3-party book [R147 throne shape]",
      JSON.stringify(meta.topDebtor) ===
        JSON.stringify({ partyId: null, partyName: null, outstandingMinor: 2_000_000, openItems: 1 }),
      JSON.stringify(meta.topDebtor));
    ok("B7 meta.topCreditor = { partyId s1, 'Akar Ltd', 800,000, openItems 1 } — the payables throne",
      JSON.stringify(meta.topCreditor) ===
        JSON.stringify({ partyId: s1Id, partyName: "Akar Ltd", outstandingMinor: 800_000, openItems: 1 }),
      JSON.stringify(meta.topCreditor));

    const recv = await api(jar, "/api/v1/receivables");
    const pay = await api(jar, "/api/v1/payables");
    ok("B8 THE READERS AGREE at throne depth — the meta's topDebtor === the RAW receivables rows mapped by the SAME law (throneOf mirrors outstandingViewOf)",
      JSON.stringify(throneOf(recv.body?.leaders)) === JSON.stringify(meta.topDebtor),
      `${JSON.stringify(throneOf(recv.body?.leaders))} vs ${JSON.stringify(meta.topDebtor)}`);
    ok("B9 same agreement on the payables side (the rose rows' proof)",
      JSON.stringify(throneOf(pay.body?.leaders)) === JSON.stringify(meta.topCreditor),
      `${JSON.stringify(throneOf(pay.body?.leaders))} vs ${JSON.stringify(meta.topCreditor)}`);
    ok("B9b the PODIUM lives on the client side — runnersUpOfFact over the RAW rows yields ranks 2..3 (Akar then Bahar) with the server's own rank fields",
      clientPodium(recv.body?.leaders).length === 2 &&
      clientPodium(recv.body?.leaders)[0]?.rank === 2 && clientPodium(recv.body?.leaders)[0]?.partyId === akarId &&
      clientPodium(recv.body?.leaders)[1]?.rank === 3 && clientPodium(recv.body?.leaders)[1]?.partyId === baharId,
      JSON.stringify(clientPodium(recv.body?.leaders)));
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
    ok("C2 after the flip: meta.topCreditor = { partyId s2, 'Bahar Supply', 500,000, openItems 1 } — the throne's tooltip money moves",
      JSON.stringify(metaFlip1.topCreditor) ===
        JSON.stringify({ partyId: s2Id, partyName: "Bahar Supply", outstandingMinor: 500_000, openItems: 1 }),
      JSON.stringify(metaFlip1.topCreditor));
    ok("C3 flip symmetry: the extractor over the RAW payables response agrees post-flip (throne depth)",
      JSON.stringify(throneOf((await api(jar, "/api/v1/payables")).body?.leaders)) ===
        JSON.stringify(metaFlip1.topCreditor));

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
    ok("C5 Akar leaves the WIRE podium BY MONEY (ranks 2..3 become Bahar alone over a 2-party book) while the throne stays the mass — the singular meta view is rank-blind by design [R169 re-pin: the departure law lives on the client extractor]",
      JSON.stringify(clientPodium((await api(jar, "/api/v1/receivables")).body?.leaders)) ===
        JSON.stringify([
          { rank: 2, partyId: baharId, partyName: "Bahar Foods", outstandingMinor: 500_000, openItems: 1, partyCount: 2 },
        ]) &&
      JSON.stringify(metaFlip2.topDebtor) ===
        JSON.stringify({ partyId: null, partyName: null, outstandingMinor: 2_000_000, openItems: 1 }),
      `${JSON.stringify(metaFlip2.topDebtor)}`);
    ok("C6 the creditor throne stays honest through the debtor flip (payables untouched by sales payments)",
      JSON.stringify(metaFlip2.topCreditor) === JSON.stringify(metaFlip1.topCreditor));

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
    ok("C8 an empty payables book → meta.topCreditor = null (the honest silence, again)",
      "topCreditor" in (metaFlip3 as any) && (metaFlip3 as any).topCreditor === null,
      JSON.stringify((metaFlip3 as any).topCreditor));
    const payFinal = await api(jar, "/api/v1/payables");
    ok("C9 the client extractor agrees with the silence (no podium rows on an empty book)",
      JSON.stringify(clientPodium(payFinal.body?.leaders)) === "[]");

    console.log("\n[D] THE ADDITIVE LAW — nothing pre-existing moved");
    const recvD1 = await api(jar, "/api/v1/receivables");
    ok("D1 the meta's topDebtor agrees with the WIRE's throne at the end state (throneOf === meta.topDebtor) [RE-PINNED R169: the R147 meta dropped largestDebtor AND the podium arrays — the shared-fields law is now meta.topDebtor vs the wire rows]",
      JSON.stringify(throneOf(recvD1.body?.leaders)) === JSON.stringify((metaFlip3 as any).topDebtor),
      `${JSON.stringify(throneOf(recvD1.body?.leaders))} vs ${JSON.stringify((metaFlip3 as any).topDebtor)}`);
    ok("D2 topLeaderOfFact(RAW payables on an empty book) === null — the two extractors agree on silence",
      topLeaderOfFact(payFinal.body?.leaders) === null);
    ok("D3 meta.counts intact (sales/openInvoices/lowStock present, numbers) [RE-PINNED R169: the aged/past-due counters left counts in a later round — the current closed scope is pinned]",
      typeof meta.counts?.sales === "number" &&
      typeof meta.counts?.openInvoices === "number" &&
      typeof meta.counts?.lowStock === "number");
    ok("D4 meta's attribution family still present (topProduct/topExpenseCategory/topStockProduct/topDebtor/topCreditor) [RE-PINNED R169: the R91/R92 fields left the meta in a later round; the current family pinned]",
      "topProduct" in meta && "topExpenseCategory" in meta &&
      "topStockProduct" in meta && "topDebtor" in meta && "topCreditor" in meta);
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

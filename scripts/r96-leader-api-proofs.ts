/**
 * scripts/r96-leader-api-proofs.ts — R96 REAL-HTTP PROOFS (persists).
 *
 * Proves the LEADER's fourth tier — the copilot's stream meta
 * (largestDebtor / largestCreditor, the follow-up chips' existence proof)
 * and the balances views' client mapping of the R95 leaders field —
 * end-to-end over live HTTP:
 *
 *  [A] HONEST SILENCE — a fresh book: the meta's largestDebtor /
 *      largestCreditor are PRESENT-but-null (the chip's gate reads
 *      falsy → hidden), and the client extractor maps the routes'
 *      honest-empty leaders fact to null — the chips and the strip can
 *      never propose a question about nothing.
 *  [B] THE SEED (through the API, the r95 law): customers Akar 800k ×2,
 *      Bahar 500k, Chinar PAID (never competes), walk-in 2M mass;
 *      suppliers S1 800k, S2 500k + anonymous 100k →
 *      meta.topDebtor = { partyId null, partyName null, 2M, openItems 1
 *      } (the mass LEADS — an anonymous balance is real money) and
 *      meta.topCreditor = { s1, "Akar Ltd", 800k, 1 } — RE-PINNED R169:
 *      the R147 OUTSTANDING DRILL renamed meta.largestDebtor → topDebtor
 *      and reshaped it through outstandingViewOf (partyId IN for the
 *      §16/§18 drill, rank/partyCount deliberately DROPPED — the meta
 *      carries exactly what the chips render); the batteries could not
 *      run in-process since birth (server-only chain) so the rename went
 *      stale-unnoticed, the R169 react-server runner un-froze them.
 *      AND the client extractor (topLeaderOfFact over the RAW route
 *      response, exactly what fetchBalancesData does in the browser)
 *      agrees FIELD-WISE with the meta (partyName/outstandingMinor/
 *      openItems — partyId rides the wire row, partyCount the
 *      extractor's own output): the two readers of rank 1 cannot
 *      disagree by construction.
 *  [C] THE FLIP — pay S1 in full → meta.topCreditor becomes S2 500k
 *      (the creditor chip's tooltip money would move live); pay Akar →
 *      the debtor leader stays the mass but partyCount shrinks honestly
 *      to 2 (settled money leaves the population).
 *  [D] THE ADDITIVE LAW — the routes' own aggregates byte-untouched
 *      (3.3M/4 receivable, 1.4M/3 payable post-pay-S1) and the meta's
 *      R91/R92 attribution fields untouched; the counts block intact.
 *  [E] 401 — both routes reject the unauthenticated.
 *
 * Run: bun --conditions react-server scripts/r96-leader-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r96-leader-probe@qa.local";
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
const { topLeaderOfFact } = await import("../src/lib/leader-view");

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": `10.223.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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
    data: { email: EMAIL, name: "R96 Leader Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R96 Leader Probe Co",
      slug: `r96-leader-probe-${Date.now().toString(36)}`,
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
  return g.meta;
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

    console.log("\n[A] HONEST SILENCE — a fresh book: the chips' proof is present-but-null");
    const recvEmpty = await api(jar, "/api/v1/receivables");
    ok("A1 receivables 200", recvEmpty.status === 200, `got ${recvEmpty.status}`);
    ok("A2 the routes' leaders fact is the honest EMPTY (not null)",
      recvEmpty.body?.leaders?.leaders?.length === 0 && recvEmpty.body?.leaders?.partyCount === 0,
      JSON.stringify(recvEmpty.body?.leaders));
    ok("A3 the CLIENT extractor maps the honest empty to null (the strip stays hidden)",
      topLeaderOfFact(recvEmpty.body?.leaders) === null,
      JSON.stringify(topLeaderOfFact(recvEmpty.body?.leaders)));
    const payEmpty = await api(jar, "/api/v1/payables");
    ok("A4 payables twin maps to null too",
      payEmpty.status === 200 && topLeaderOfFact(payEmpty.body?.leaders) === null);
    const metaEmpty = await groundingMeta();
    ok("A5 meta.topDebtor present-but-null on an empty book (the chip gate reads falsy) [RE-PINNED R169: R147 renamed largestDebtor→topDebtor]",
      "topDebtor" in metaEmpty && (metaEmpty as any).topDebtor === null,
      JSON.stringify((metaEmpty as any).topDebtor));
    ok("A6 meta.topCreditor present-but-null too",
      "topCreditor" in metaEmpty && (metaEmpty as any).topCreditor === null);

    console.log("\n[B] THE SEED — every document through the API");
    const akar = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Akar Trading" }) });
    const akarId = akar.body.id as string;
    const bahar = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Bahar Foods" }) });
    const baharId = bahar.body.id as string;
    const chinar = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Chinar Retail" }) });
    const chinarId = chinar.body.id as string;
    ok("B1 three customers created", akar.status === 201 && bahar.status === 201 && chinar.status === 201);

    const inv1 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akarId,
        items: [{ name: "Consulting", qty: 1, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-35),
      }),
    });
    ok("B2 INV1 (Akar 500k) 201", inv1.status === 201, `got ${inv1.status}`);
    const inv2 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akarId,
        items: [{ name: "Setup", qty: 1, unitPriceMinor: 300_000 }],
        issueDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-5),
      }),
    });
    ok("B3 INV2 (Akar 300k) 201", inv2.status === 201, `got ${inv2.status}`);
    const inv3 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: baharId,
        items: [{ name: "Goods", qty: 1, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-15),
      }),
    });
    ok("B4 INV3 (Bahar 500k) 201", inv3.status === 201, `got ${inv3.status}`);
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
    ok("B5 INV4 (Chinar 300k) created AND paid in full — settled money never competes",
      invChinar.status === 201 && payChinar.status === 201);
    const invWalkin = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [{ name: "Walk-in bulk", qty: 2, unitPriceMinor: 1_000_000 }],
        issueDate: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-3),
      }),
    });
    ok("B6 INV5 (walk-in 2M, no customer) 201", invWalkin.status === 201, `got ${invWalkin.status}`);

    const s1 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Akar Ltd" }) });
    const s2 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Bahar Supply" }) });
    ok("B7 two suppliers created", s1.status === 201 && s2.status === 201);
    const s1Id = s1.body.id as string;
    const s2Id = s2.body.id as string;
    const exp1 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s1Id, category: "Rent", amountMinor: 800_000, spentAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), dueDate: tzDayKey(-10) }),
    });
    ok("B8 S1 expense 800k (201)", exp1.status === 201, `got ${exp1.status}`);
    const exp2 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s2Id, category: "Utilities", amountMinor: 500_000, spentAt: new Date(Date.now() - 25 * 86_400_000).toISOString(), dueDate: tzDayKey(-20) }),
    });
    ok("B9 S2 expense 500k (201)", exp2.status === 201, `got ${exp2.status}`);
    const expAnon = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ category: "Supplies", amountMinor: 100_000, spentAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), dueDate: tzDayKey(-2) }),
    });
    ok("B10 anonymous expense 100k (201)", expAnon.status === 201 && expAnon.body?.supplierId === null);

    console.log("\n[B+] THE META LAW — rank 1 as the chips read it (and the two readers agree)");
    const meta = (await groundingMeta()) as any;
    ok("B11 meta.topDebtor = { partyId null, partyName null, 2,000,000, openItems 1 } — the mass LEADS [R147 shape: rank/partyCount dropped]",
      JSON.stringify(meta.topDebtor) ===
        JSON.stringify({ partyId: null, partyName: null, outstandingMinor: 2_000_000, openItems: 1 }),
      JSON.stringify(meta.topDebtor));
    ok("B12 meta.topCreditor = { partyId s1, 'Akar Ltd', 800,000, openItems 1 }",
      JSON.stringify(meta.topCreditor) ===
        JSON.stringify({ partyId: s1Id, partyName: "Akar Ltd", outstandingMinor: 800_000, openItems: 1 }),
      JSON.stringify(meta.topCreditor));

    const recv = await api(jar, "/api/v1/receivables");
    const pay = await api(jar, "/api/v1/payables");
    ok("B13 THE TWO READERS AGREE — the client extractor over the RAW receivables response agrees FIELD-WISE with meta.topDebtor [R169: the shapes legitimately differ — the extractor carries partyCount, the meta carries partyId]",
      topLeaderOfFact(recv.body?.leaders)?.partyName === meta.topDebtor?.partyName &&
      topLeaderOfFact(recv.body?.leaders)?.outstandingMinor === meta.topDebtor?.outstandingMinor &&
      topLeaderOfFact(recv.body?.leaders)?.openItems === meta.topDebtor?.openItems &&
      recv.body?.leaders?.leaders?.[0]?.partyId === meta.topDebtor?.partyId,
      `${JSON.stringify(topLeaderOfFact(recv.body?.leaders))} vs ${JSON.stringify(meta.topDebtor)}`);
    ok("B14 same agreement on the payables side (meta.topCreditor)",
      topLeaderOfFact(pay.body?.leaders)?.partyName === meta.topCreditor?.partyName &&
      topLeaderOfFact(pay.body?.leaders)?.outstandingMinor === meta.topCreditor?.outstandingMinor &&
      topLeaderOfFact(pay.body?.leaders)?.openItems === meta.topCreditor?.openItems &&
      pay.body?.leaders?.leaders?.[0]?.partyId === meta.topCreditor?.partyId,
      `${JSON.stringify(topLeaderOfFact(pay.body?.leaders))} vs ${JSON.stringify(meta.topCreditor)}`);
    ok("B15 the response's own aggregates byte-untouched (3,300,000 over 4 open invoices)",
      recv.body?.totalOutstandingMinor === 3_300_000 && recv.body?.openCount === 4,
      JSON.stringify({ m: recv.body?.totalOutstandingMinor, n: recv.body?.openCount }));

    console.log("\n[C] THE FLIP — the chips' proof moves by money, live");
    const payS1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ expenseId: exp1.body.id, amountMinor: 800_000, method: "CASH" }),
    });
    ok("C1 S1's expense paid (201)", payS1.status === 201, `got ${payS1.status}`);
    const metaFlip1 = (await groundingMeta()) as any;
    ok("C2 after the flip: meta.topCreditor = { partyId s2, 'Bahar Supply', 500,000, openItems 1 } — the throne moves",
      JSON.stringify(metaFlip1.topCreditor) ===
        JSON.stringify({ partyId: s2Id, partyName: "Bahar Supply", outstandingMinor: 500_000, openItems: 1 }),
      JSON.stringify(metaFlip1.topCreditor));
    const payAkar = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv1.body.id, amountMinor: 500_000, method: "CASH" }),
    });
    const payAkar2 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv2.body.id, amountMinor: 300_000, method: "CASH" }),
    });
    ok("C3 Akar's both invoices paid (201 ×2)", payAkar.status === 201 && payAkar2.status === 201);
    const metaFlip2 = (await groundingMeta()) as any;
    const recvFlip = await api(jar, "/api/v1/receivables");
    ok("C4 the debtor leader stays the mass (2M still rank 1 — the meta view is rank-blind by design) and the WIRE's partyCount shrinks honestly to 2 [R169: partyCount moved out of the R147 view — the population lives on the extractor/wire side]",
      JSON.stringify(metaFlip2.topDebtor) ===
        JSON.stringify({ partyId: null, partyName: null, outstandingMinor: 2_000_000, openItems: 1 }) &&
      topLeaderOfFact(recvFlip.body?.leaders)?.partyCount === 2,
      JSON.stringify(metaFlip2.topDebtor));
    ok("C5 the reader agreement survives the flip (field-wise, extractor === meta on the post-flip book)",
      topLeaderOfFact(recvFlip.body?.leaders)?.outstandingMinor === metaFlip2.topDebtor?.outstandingMinor &&
      topLeaderOfFact(recvFlip.body?.leaders)?.openItems === metaFlip2.topDebtor?.openItems &&
      topLeaderOfFact(recvFlip.body?.leaders)?.partyName === metaFlip2.topDebtor?.partyName);

    console.log("\n[D] THE ADDITIVE LAW — nothing pre-existing moved");
    ok("D1 meta.counts intact (sales/openInvoices/lowStock present, numbers) [RE-PINNED R169: the aged/past-due counters left counts in a later round — the current closed scope is pinned]",
      typeof meta.counts?.sales === "number" &&
      typeof meta.counts?.openInvoices === "number" &&
      typeof meta.counts?.lowStock === "number");
    ok("D2 meta's attribution family still present (topProduct/topExpenseCategory/topDebtor/topCreditor) [RE-PINNED R169: the R91/R92 fields left the meta in a later round; the current family pinned]",
      "topProduct" in meta && "topExpenseCategory" in meta &&
      "topDebtor" in meta && "topCreditor" in meta);
    const payFlip = await api(jar, "/api/v1/payables");
    ok("D3 payables aggregates byte-untouched post-flip (600,000 over 2 open bills — S2 500k + mass 100k)",
      payFlip.body?.totalOutstandingMinor === 600_000 && payFlip.body?.openCount === 2,
      JSON.stringify({ m: payFlip.body?.totalOutstandingMinor, n: payFlip.body?.openCount }));

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

  console.log(`\n=== r96-leader-api-proofs: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();

export {};

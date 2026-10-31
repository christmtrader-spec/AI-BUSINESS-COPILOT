/**
 * scripts/r95-leaders-api-proofs.ts — R95 REAL-HTTP PROOFS (persists).
 *
 * Proves the book's LEADERS FACT end-to-end — the ranked top parties by
 * open balance (the R89 board's own order) as it ships through the
 * dashboard routes and the copilot grounding:
 *
 *  [A] HONEST SILENCE — a fresh book: GET /api/v1/receivables +
 *      /api/v1/payables carry leaders = { leaders: [], partyCount: 0 }
 *      (an honest empty, NOT null — null is reserved for the truncated
 *      whole-book read); the response's own shape untouched (additive).
 *  [B] THE SEED — every document through the API: Akar 800k (2 invoices),
 *      Bahar 500k, Chinar 300k PAID IN FULL, walk-in 2M (no customer) →
 *      receivables leaders = [mass 2M rank1, Akar 800k rank2, Bahar 500k
 *      rank3], partyCount 3 — Chinar's settled money never competes and
 *      the mass LEADS (an anonymous balance is real owed money).
 *  [C] THE FLIP — Akar paid in full → Akar leaves the leaders, Bahar
 *      moves UP to rank 2 (money decides, live).
 *  [D] THE PAYABLES TWIN — suppliers S1 800k / S2 500k + anonymous 100k →
 *      payables leaders [S1, S2, mass], partyCount 3; paying S1 → S2 rank 1.
 *  [E] THE COPILOT GROUNDING — buildCopilotGrounding over the SAME seeded
 *      book [RE-PINNED R169: the R95-era largestDebtors/largestCreditors
 *      ARRAYS became the SINGULAR largestDebtor/largestCreditor through
 *      topLeaderOfFact, the '6d. BOOK LEADERS' prompt law left in a later
 *      round, and the meta's attribution family rotated — the battery
 *      could not run in-process since birth (the server-only chain) so
 *      every drift went stale-unnoticed; the R169 react-server runner
 *      un-froze it]: the snapshot's singular throne citations carry the
 *      parties VERBATIM (name — null for the mass — integer minor units,
 *      openItems, partyCount); the system prompt speaks the CURRENT
 *      verbatim-citation law family (6b/6e/6f) and embeds the singular
 *      leader keys; the meta's attribution family is untouched (additive
 *      law); the attention figures reconcile.
 *  [F] 401 — both dashboard routes reject the unauthenticated.
 *
 * Run: bun --conditions react-server scripts/r95-leaders-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r95-leaders-probe@qa.local";
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

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": `10.222.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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
    data: { email: EMAIL, name: "R95 Leaders Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R95 Leaders Probe Co",
      slug: `r95-leaders-probe-${Date.now().toString(36)}`,
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

    console.log("\n[A] HONEST SILENCE — a fresh book carries an EMPTY leaders list (never a fabrication)");
    const recvEmpty = await api(jar, "/api/v1/receivables");
    ok("A1 receivables 200", recvEmpty.status === 200, `got ${recvEmpty.status}`);
    ok("A2 leaders = { leaders: [], partyCount: 0 } (honest empty — null is the truncated read's shape)",
      recvEmpty.body?.leaders?.leaders?.length === 0 && recvEmpty.body?.leaders?.partyCount === 0,
      JSON.stringify(recvEmpty.body?.leaders));
    ok("A3 the response's own shape untouched (totalOutstandingMinor/openCount/byCustomer present) — additive",
      typeof recvEmpty.body?.totalOutstandingMinor === "number" &&
      typeof recvEmpty.body?.openCount === "number" &&
      Array.isArray(recvEmpty.body?.byCustomer));
    const payEmpty = await api(jar, "/api/v1/payables");
    ok("A4 payables twin: leaders honest empty", payEmpty.status === 200 &&
      payEmpty.body?.leaders?.leaders?.length === 0 && payEmpty.body?.leaders?.partyCount === 0,
      JSON.stringify(payEmpty.body?.leaders));

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

    const seeded = await api(jar, "/api/v1/receivables");
    const L = seeded.body?.leaders;
    ok("B7 leaders = [mass 2M rank1, Akar 800k rank2, Bahar 500k rank3] — the mass LEADS, money decides",
      L?.leaders?.length === 3 &&
      L.leaders[0].rank === 1 && L.leaders[0].partyId === null && L.leaders[0].outstandingMinor === 2_000_000 && L.leaders[0].count === 1 &&
      L.leaders[1].rank === 2 && L.leaders[1].partyId === akarId && L.leaders[1].outstandingMinor === 800_000 && L.leaders[1].count === 2 &&
      L.leaders[2].rank === 3 && L.leaders[2].partyId === baharId && L.leaders[2].outstandingMinor === 500_000 && L.leaders[2].count === 1,
      JSON.stringify(L));
    ok("B8 partyCount = 3 (Chinar's settled row never enters the population)",
      L?.partyCount === 3, JSON.stringify(L?.partyCount));
    ok("B9 partyName carried for named leaders (the UI truncates; the API ships the truth)",
      L?.leaders?.[1]?.partyName === "Akar Trading" && L?.leaders?.[2]?.partyName === "Bahar Foods");
    ok("B10 the response's own aggregates exact and untouched (3,300,000 over 4 open invoices — Akar 800k + Bahar 500k + walk-in 2M)",
      seeded.body?.totalOutstandingMinor === 3_300_000 && seeded.body?.openCount === 4,
      JSON.stringify({ m: seeded.body?.totalOutstandingMinor, n: seeded.body?.openCount }));

    console.log("\n[C] THE FLIP — money decides, live");
    const pay1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv1.body.id, amountMinor: 500_000, method: "CASH" }),
    });
    const pay2 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv2.body.id, amountMinor: 300_000, method: "CASH" }),
    });
    ok("C1 Akar's both invoices paid (201 ×2)", pay1.status === 201 && pay2.status === 201);
    const flipped = await api(jar, "/api/v1/receivables");
    const LF = flipped.body?.leaders;
    ok("C2 after the flip: [mass 2M, Bahar 500k rank2] — Akar left the leaders, Bahar moved UP",
      LF?.leaders?.length === 2 &&
      LF.leaders[0].partyId === null && LF.leaders[0].outstandingMinor === 2_000_000 &&
      LF.leaders[1].rank === 2 && LF.leaders[1].partyId === baharId && LF.leaders[1].outstandingMinor === 500_000,
      JSON.stringify(LF));
    ok("C3 partyCount shrank honestly to 2 (settled Akar is out of the population)",
      LF?.partyCount === 2, JSON.stringify(LF?.partyCount));

    console.log("\n[D] THE PAYABLES TWIN — the same law on the Expense authority");
    const s1 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Akar Ltd" }) });
    const s2 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Bahar Supply" }) });
    ok("D1 two suppliers created", s1.status === 201 && s2.status === 201);
    const s1Id = s1.body.id as string;
    const s2Id = s2.body.id as string;
    const exp1 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s1Id, category: "Rent", amountMinor: 800_000, spentAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), dueDate: tzDayKey(-10) }),
    });
    ok("D2 S1 expense 800k (201)", exp1.status === 201, `got ${exp1.status}`);
    const exp2 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s2Id, category: "Utilities", amountMinor: 500_000, spentAt: new Date(Date.now() - 25 * 86_400_000).toISOString(), dueDate: tzDayKey(-20) }),
    });
    ok("D3 S2 expense 500k (201)", exp2.status === 201, `got ${exp2.status}`);
    const expAnon = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ category: "Supplies", amountMinor: 100_000, spentAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), dueDate: tzDayKey(-2) }),
    });
    ok("D4 anonymous expense 100k (201, supplierId null)", expAnon.status === 201 && expAnon.body?.supplierId === null);

    const paySeeded = await api(jar, "/api/v1/payables");
    const LP = paySeeded.body?.leaders;
    ok("D5 payables leaders = [S1 800k rank1, S2 500k rank2, mass 100k rank3], partyCount 3",
      LP?.leaders?.length === 3 &&
      LP.leaders[0].rank === 1 && LP.leaders[0].partyId === s1Id && LP.leaders[0].outstandingMinor === 800_000 &&
      LP.leaders[1].rank === 2 && LP.leaders[1].partyId === s2Id && LP.leaders[1].outstandingMinor === 500_000 &&
      LP.leaders[2].rank === 3 && LP.leaders[2].partyId === null && LP.leaders[2].outstandingMinor === 100_000,
      JSON.stringify(LP));
    const payS1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ expenseId: exp1.body.id, amountMinor: 800_000, method: "CASH" }),
    });
    ok("D6 S1's expense paid (201)", payS1.status === 201, `got ${payS1.status}`);
    const payFlipped = await api(jar, "/api/v1/payables");
    const LPF = payFlipped.body?.leaders;
    ok("D7 after the flip: [S2 500k rank1, mass 100k rank2] — the creditor throne moves by money",
      LPF?.leaders?.length === 2 &&
      LPF.leaders[0].rank === 1 && LPF.leaders[0].partyId === s2Id && LPF.leaders[0].outstandingMinor === 500_000 &&
      LPF.leaders[1].rank === 2 && LPF.leaders[1].partyId === null,
      JSON.stringify(LPF));

    console.log("\n[E] THE COPILOT GROUNDING — the model can NAME the leaders verbatim");
    const { buildCopilotGrounding } = await import("../src/lib/ai/snapshot");
    const { formatMoney } = await import("../src/lib/money");
    const grounding = await buildCopilotGrounding({
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
    const snap = JSON.parse(grounding.dataBlock);
    const money = {
      currencyCode: business.currencyCode,
      currencySymbol: business.currencySymbol,
      decimalPrecision: business.decimalPrecision,
      locale: business.locale,
    };
    // RE-PINNED R169 (honest archaeology): the R95-era snapshot carried
    // largestDebtors/largestCreditors ARRAYS (pre-formatted balance strings);
    // a later round reshaped them to the SINGULAR largestDebtor/largestCreditor
    // through topLeaderOfFact ({partyName, outstandingMinor, openItems,
    // partyCount} — integer minor units, the citation shape). The battery
    // could not run in-process since birth (the server-only chain) so the
    // reshape went stale-unnoticed; the R169 react-server runner un-froze it.
    ok("E1 largestDebtor = the mass throne {partyName null, 2M, openItems 1, partyCount 2} — the anonymous balance LEADS and pre-formatted money lives elsewhere (post-flip book) [R169: singular citation shape]",
      JSON.stringify(snap.outstandingAllTime?.largestDebtor) ===
        JSON.stringify({ partyName: null, outstandingMinor: 2_000_000, openItems: 1, partyCount: 2 }),
      JSON.stringify(snap.outstandingAllTime?.largestDebtor));
    ok("E2 largestCreditor twin = { partyName 'Bahar Supply', 500k, 1, partyCount 2 } — same law, payables side",
      JSON.stringify(snap.outstandingAllTime?.largestCreditor) ===
        JSON.stringify({ partyName: "Bahar Supply", outstandingMinor: 500_000, openItems: 1, partyCount: 2 }),
      JSON.stringify(snap.outstandingAllTime?.largestCreditor));
    ok("E3 the system prompt speaks the CURRENT leader law family (6b/6e/6f verbatim-citation rules) and embeds the snapshot's singular leader keys [R169 re-pin: the R95-era '6d. BOOK LEADERS' numbered law left the prompt in a later round — the debtors citation now rides the embedded snapshot + rules 1/4]",
      grounding.systemPrompt.includes('6b.') &&
      grounding.systemPrompt.includes('6e.') &&
      grounding.systemPrompt.includes('6f.') &&
      grounding.systemPrompt.includes('"largestDebtor"') &&
      grounding.systemPrompt.includes('"largestCreditor"'));
    ok("E4 the grounding meta's attribution family untouched (topProduct/topExpenseCategory/topDebtor/topCreditor present, additive law) [R169 re-pin: the R91/R92 fields left the meta in a later round]",
      "topProduct" in grounding.meta && "topExpenseCategory" in grounding.meta &&
      "topDebtor" in grounding.meta && "topCreditor" in grounding.meta);
    ok("E5 the snapshot's attention figures still reconcile (customersOweYou = post-flip 2.5M)",
      snap.outstandingAllTime?.customersOweYou === formatMoney(2_500_000, money),
      JSON.stringify(snap.outstandingAllTime?.customersOweYou));

    console.log("\n[F] 401 — the dashboard routes reject the unauthenticated");
    const f401a = await fetch(`${BASE}/api/v1/receivables`, { redirect: "manual" });
    const f401b = await fetch(`${BASE}/api/v1/payables`, { redirect: "manual" });
    ok("F1 both routes 401 unauthenticated", f401a.status === 401 && f401b.status === 401,
      `${f401a.status}/${f401b.status}`);

  } finally {
    if (!process.argv.includes("--keep")) {
      await cleanup();
    }
    await db.$disconnect();
  }

  console.log(`\n=== r95-leaders-api-proofs: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();

export {};

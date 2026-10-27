/**
 * scripts/r94-party-rank-api-proofs.ts — R94 SEEDED API PROOFS (persists).
 *
 * Exercises the REAL HTTP surface (credentials login → session cookie →
 * x-business-id) proving the 360 RANK CITATION end to end:
 *
 *   [A] HONEST SILENCE — a fresh book cites NO rank (rank/partyCount null)
 *   [B] THE SEED — Akar (800k) + Bahar (500k) + a WALK-IN invoice (2M, no
 *       customer) + Chinar settled in full → the detail API ranks exactly
 *       as the R89 board does: mass rank 1, Akar 2, Bahar 3, and a party
 *       held up only by settled money is honestly ABSENT (null, not a lie)
 *   [C] THE FLIP — paying Akar in full moves Bahar's rank up and silences
 *       Akar's citation
 *   [D] THE PAYABLES TWIN — supplier expenses: the same law on the other
 *       side of the book (S1 rank 1 of 4; the name-tie law live)
 *   [E] THE BOARD IDENTITY — the 360 rank equals the party's position in
 *       the LIVE /reports/aging/items partyRollup (same comparator, HTTP-
 *       level proof — the citation and the board can never disagree)
 *   [F] GUARDS — 401
 *
 * Run:  bun scripts/r94-party-rank-api-proofs.ts
 *       bun scripts/r94-party-rank-api-proofs.ts --keep      (leave fixture for browser QA)
 *       bun scripts/r94-party-rank-api-proofs.ts --cleanup   (FK-safe sweep)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r94-rank-probe@qa.local";
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
      "x-forwarded-for": `10.221.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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
    data: { email: EMAIL, name: "R94 Rank Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R94 Rank Probe Co",
      slug: `r94-rank-probe-${Date.now().toString(36)}`,
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

    console.log("\n[A] HONEST SILENCE — an empty book cites no rank");
    const akar = await api(jar, "/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Akar Trading" }),
    });
    ok("A1 Akar created", akar.status === 201 && !!akar.body?.id, `status ${akar.status}`);
    const akarId = akar.body.id as string;
    const detailEmpty = await api(jar, `/api/v1/customers/${akarId}`);
    ok("A2 detail 200", detailEmpty.status === 200, `got ${detailEmpty.status}`);
    ok("A3 rank null on an empty book", detailEmpty.body?.receivablesAging?.rank === null,
      JSON.stringify(detailEmpty.body?.receivablesAging?.rank));
    ok("A4 partyCount null on an empty book", detailEmpty.body?.receivablesAging?.partyCount === null,
      JSON.stringify(detailEmpty.body?.receivablesAging?.partyCount));
    ok("A5 the summary's own figures untouched (0 items, 0 outstanding)",
      detailEmpty.body?.receivablesAging?.openItemCount === 0 &&
      detailEmpty.body?.receivablesAging?.totalOutstandingMinor === 0);

    console.log("\n[B] THE SEED — every document through the API");
    const bahar = await api(jar, "/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Bahar Foods" }),
    });
    const baharId = bahar.body.id as string;
    const chinar = await api(jar, "/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Chinar Retail" }),
    });
    const chinarId = chinar.body.id as string;
    ok("B1 Bahar + Chinar created", bahar.status === 201 && chinar.status === 201);

    // Akar: two open invoices (500k + 300k = 800k outstanding).
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

    // Bahar: one open invoice (500k).
    const inv3 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: baharId,
        items: [{ name: "Delivery", qty: 1, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-15),
      }),
    });
    ok("B4 INV3 (Bahar 500k) 201", inv3.status === 201, `got ${inv3.status}`);

    // Chinar: one invoice, PAID IN FULL within the round (settled money).
    const inv4 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: chinarId,
        items: [{ name: "Counter restock", qty: 1, unitPriceMinor: 300_000 }],
        issueDate: new Date(Date.now() - 15 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-10),
      }),
    });
    ok("B5 INV4 (Chinar 300k) 201", inv4.status === 201, `got ${inv4.status}`);
    const payChinar = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv4.body.id, amountMinor: 300_000, method: "CASH" }),
    });
    ok("B6 Chinar paid in full (201)", payChinar.status === 201, `got ${payChinar.status}`);

    // The WALK-IN: 2M, no customer — the mass the board ranks first.
    const inv5 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [{ name: "Walk-in bulk", qty: 2, unitPriceMinor: 1_000_000 }],
        issueDate: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-3),
      }),
    });
    ok("B7 INV5 (walk-in 2M) 201", inv5.status === 201, `got ${inv5.status}`);

    const akarDetail = await api(jar, `/api/v1/customers/${akarId}`);
    const ag = akarDetail.body?.receivablesAging;
    ok("B8 Akar rank = 2 (the 2M mass outranks the 800k)", ag?.rank === 2, JSON.stringify(ag?.rank));
    ok("B9 Akar partyCount = 3 (mass + Akar + Bahar; Chinar's settled row never counts)",
      ag?.partyCount === 3, JSON.stringify(ag?.partyCount));
    ok("B10 the summary's own figures exact (2 items · 800,000) — the merge is ADDITIVE",
      ag?.openItemCount === 2 && ag?.totalOutstandingMinor === 800_000,
      JSON.stringify({ n: ag?.openItemCount, m: ag?.totalOutstandingMinor }));

    const baharDetail = await api(jar, `/api/v1/customers/${baharId}`);
    ok("B11 Bahar rank = 3 of 3 (500k < Akar's 800k < mass 2M)",
      baharDetail.body?.receivablesAging?.rank === 3 &&
      baharDetail.body?.receivablesAging?.partyCount === 3,
      JSON.stringify(baharDetail.body?.receivablesAging?.rank));

    const chinarDetail = await api(jar, `/api/v1/customers/${chinarId}`);
    ok("B12 Chinar (settled only) — rank honestly ABSENT (null), never a fabricated standing",
      chinarDetail.body?.receivablesAging?.rank === null &&
      chinarDetail.body?.receivablesAging?.partyCount === null &&
      chinarDetail.body?.receivablesAging?.openItemCount === 0,
      JSON.stringify(chinarDetail.body?.receivablesAging?.rank));

    console.log("\n[C] THE FLIP — money decides");
    const pay1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv1.body.id, amountMinor: 500_000, method: "CASH" }),
    });
    const pay2 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv2.body.id, amountMinor: 300_000, method: "CASH" }),
    });
    ok("C1 Akar's both invoices paid (201 ×2)", pay1.status === 201 && pay2.status === 201);
    const akarAfter = await api(jar, `/api/v1/customers/${akarId}`);
    ok("C2 Akar's citation gone (null — the flip law)",
      akarAfter.body?.receivablesAging?.rank === null &&
      akarAfter.body?.receivablesAging?.partyCount === null);
    const baharAfter = await api(jar, `/api/v1/customers/${baharId}`);
    ok("C3 Bahar moved UP to rank 2 of 2 (mass + Bahar)",
      baharAfter.body?.receivablesAging?.rank === 2 &&
      baharAfter.body?.receivablesAging?.partyCount === 2,
      JSON.stringify(baharAfter.body?.receivablesAging?.rank));

    console.log("\n[D] THE PAYABLES TWIN — the same law on the Expense authority");
    const s1 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Akar Ltd" }) });
    const s2 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Bahar Supply" }) });
    const s3 = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Chiran Co" }) });
    ok("D1 three suppliers created", s1.status === 201 && s2.status === 201 && s3.status === 201);
    const s1Id = s1.body.id as string;
    const s2Id = s2.body.id as string;
    const s3Id = s3.body.id as string;
    const exp1 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s1Id, category: "Rent", amountMinor: 800_000, spentAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), dueDate: tzDayKey(-10) }),
    });
    ok("D2 S1 expense 800k (201)", exp1.status === 201, `got ${exp1.status}`);
    const exp2 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s2Id, category: "Utilities", amountMinor: 300_000, spentAt: new Date(Date.now() - 25 * 86_400_000).toISOString(), dueDate: tzDayKey(-20) }),
    });
    const exp3 = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ supplierId: s3Id, category: "Internet", amountMinor: 300_000, spentAt: new Date(Date.now() - 25 * 86_400_000).toISOString(), dueDate: tzDayKey(-20) }),
    });
    ok("D3 S2+S3 expenses 300k each (201 ×2)", exp2.status === 201 && exp3.status === 201);
    const expAnon = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ category: "Supplies", amountMinor: 100_000, spentAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), dueDate: tzDayKey(-2) }),
    });
    ok("D4 anonymous expense 100k (201, supplierId null)", expAnon.status === 201 && expAnon.body?.supplierId === null);

    const s1Detail = await api(jar, `/api/v1/suppliers/${s1Id}`);
    const pag = s1Detail.body?.payablesAging;
    ok("D5 S1 rank = 1 of 4 (800k tops the payables)", pag?.rank === 1 && pag?.partyCount === 4,
      JSON.stringify({ r: pag?.rank, m: pag?.partyCount }));
    ok("D6 S1 summary exact (1 item · 800,000 · past-due 1) — additive merge",
      pag?.openItemCount === 1 && pag?.totalOutstandingMinor === 800_000 && pag?.pastDueCount === 1,
      JSON.stringify({ n: pag?.openItemCount, m: pag?.totalOutstandingMinor, pd: pag?.pastDueCount }));
    const s2Detail = await api(jar, `/api/v1/suppliers/${s2Id}`);
    const s3Detail = await api(jar, `/api/v1/suppliers/${s3Id}`);
    ok("D7 the 300k tie broken by NAME asc — Bahar Supply rank 2, Chiran Co rank 3 (the board's chain)",
      s2Detail.body?.payablesAging?.rank === 2 && s3Detail.body?.payablesAging?.rank === 3 &&
      s2Detail.body?.payablesAging?.partyCount === 4,
      JSON.stringify({ s2: s2Detail.body?.payablesAging?.rank, s3: s3Detail.body?.payablesAging?.rank }));

    console.log("\n[E] THE BOARD IDENTITY — the 360 rank IS the board's position (live HTTP)");
    const board = await api(jar, "/api/v1/reports/aging/items?side=receivables");
    const groups = board.body?.summary?.partyRollup?.groups ?? [];
    ok("E1 board present with 2 groups (the 2M mass + Bahar — Akar paid off in [C])",
      groups.length === 2 && groups[0]?.partyId === null && groups[1]?.partyId === baharId,
      JSON.stringify(groups.map((g: any) => g.partyName)));
    const baharNow = await api(jar, `/api/v1/customers/${baharId}`);
    // The position is over ALL groups — the unassigned mass occupies rank 1
    // on the board exactly as it does in the 360's count.
    const boardIdx = groups.findIndex((g: any) => g.partyId === baharId);
    ok("E2 Bahar's 360 rank === their 1-based position on the live board (mass included)",
      boardIdx >= 0 && baharNow.body?.receivablesAging?.rank === boardIdx + 1,
      `board idx ${boardIdx} vs rank ${baharNow.body?.receivablesAging?.rank}`);
    const boardPay = await api(jar, "/api/v1/reports/aging/items?side=payables");
    const pGroups = boardPay.body?.summary?.partyRollup?.groups ?? [];
    const s1Idx = pGroups.findIndex((g: any) => g.partyId === s1Id);
    ok("E3 S1's 360 rank === their 1-based position on the live payables board",
      s1Idx === 0 && s1Detail.body?.payablesAging?.rank === s1Idx + 1,
      `board idx ${s1Idx} vs rank ${s1Detail.body?.payablesAging?.rank}`);
    ok("E4 the payables board holds all 4 groups (3 suppliers + the anonymous mass), S1 first",
      pGroups.length === 4 && pGroups[0]?.partyId === s1Id,
      JSON.stringify(pGroups.map((g: any) => g.partyName)));

    console.log("\n[F] GUARDS");
    const anonRes = await fetch(`${BASE}/api/v1/customers/${akarId}`, {
      headers: { "x-business-id": BIZ_ID },
    });
    ok("F1 unauthenticated detail → 401", anonRes.status === 401, `got ${anonRes.status}`);

    console.log(`\n=== r94-party-rank-api-proofs: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      console.log("FAILURES:", failures.join(" | "));
      process.exitCode = 1;
    }
  } finally {
    if (!process.argv.includes("--keep")) await cleanup();
    await db.$disconnect();
  }
}

main();

export {};

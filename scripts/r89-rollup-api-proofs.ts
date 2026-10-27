/**
 * scripts/r89-rollup-api-proofs.ts — R89 SEEDED API PROOFS (temp harness).
 *
 * Exercises the REAL HTTP surface (credentials login → session cookie →
 * x-business-id) against the seeded probe business, proving the per-party
 * roll-up END TO END:
 *   [A] all-parties receivables board — ranked EXACT, counts + oldest days,
 *       board sum === filtered total === full total (no chips), PAID party
 *       absent, unassigned group honest
 *   [B] the overdue chip lens — the board shrinks to the breaching parties
 *       and reconciles with summary.overdueMinor
 *   [C] the bucket chip lens — D0_30 board excludes the aged group
 *   [D] the over-60 union lens — only the aged parties remain
 *   [E] party-scoped request — partyRollup is honest NULL
 *   [F] the 13-filler truncation — groups capped at 12, groupCount
 *       untrimmed, groupsTruncated honest (the API-level cap proof)
 *   [G] payables side — the same board law on the supplier expense scope
 *
 * Run:  bun scripts/r89-rollup-api-proofs.ts
 *       bun scripts/r89-rollup-api-proofs.ts --cleanup   (FK-safe sweep)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r89-rollup-probe@qa.local";
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
      "x-forwarded-for": `10.219.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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

async function api(jar: Map<string, string>, path: string, businessId?: string) {
  const f = jarFetch(jar);
  const res = await f(path, {
    headers: {
      "content-type": "application/json",
      ...(businessId ? { "x-business-id": businessId } : {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

const daysAgo = (n: number, hourUtc = 9) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

async function seed() {
  const passwordHash = await import("bcryptjs").then((m) => m.default.hashSync(PASS, 10));
  const user = await db.user.create({
    data: { email: EMAIL, name: "R89 Rollup Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R89 Rollup Probe Co",
      slug: `r89-rollup-probe-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: user.id,
    },
  });
  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });

  const mkCustomer = (name: string) =>
    db.customer.create({ data: { businessId: business.id, name } });

  const akar = await mkCustomer("Akar Industrial");
  const bahman = await mkCustomer("Bahman Trading");
  const chista = await mkCustomer("Chista Retail");

  // 13 filler parties — tiny balances, young age (rank noise below the main groups).
  const fillers = [] as { id: string }[];
  for (let i = 0; i < 13; i++) fillers.push(await mkCustomer(`Filler ${String(i + 1).padStart(2, "0")}`));

  let number = 0;
  const mkSale = (p: {
    customerId?: string | null;
    totalMinor: number;
    paidMinor?: number;
    status?: string;
    issueDaysAgo: number;
    dueDaysAgo?: number | null;
  }) =>
    db.sale.create({
      data: {
        businessId: business.id,
        number: ++number,
        customerId: p.customerId ?? null,
        subtotalMinor: p.totalMinor,
        totalMinor: p.totalMinor,
        paidMinor: p.paidMinor ?? 0,
        status: p.status ?? "UNPAID",
        issueDate: daysAgo(p.issueDaysAgo),
        ...(p.dueDaysAgo != null ? { dueDate: daysAgo(p.dueDaysAgo) } : {}),
      },
    });

  // Akar: aged OVERDUE invoice (50d old, due 3d ago) + young open one.
  await mkSale({ customerId: akar.id, totalMinor: 1_000_000, issueDaysAgo: 50, dueDaysAgo: 3 });
  await mkSale({ customerId: akar.id, totalMinor: 300_000, issueDaysAgo: 5 });
  // Bahman: mid-aged open (45d → D31_60).
  await mkSale({ customerId: bahman.id, totalMinor: 2_000_000, issueDaysAgo: 45 });
  // Chista: SETTLED — excluded by the open guard (party never on the board).
  await mkSale({ customerId: chista.id, totalMinor: 750_000, status: "PAID", paidMinor: 750_000, issueDaysAgo: 20 });
  // Unassigned: aged 70d (D61_90) — its own honest group.
  await mkSale({ totalMinor: 250_000, issueDaysAgo: 70 });
  // Fillers: young tiny invoices (D0_30), descending amounts below the main groups.
  for (let i = 0; i < 13; i++) {
    await mkSale({ customerId: fillers[i].id, totalMinor: 200 - i, issueDaysAgo: 2 });
  }

  const mkSupplier = (name: string) => db.supplier.create({ data: { businessId: business.id, name } });
  const s1 = await mkSupplier("Sadaf Logistics");
  const s2 = await mkSupplier("Kavir Supplies");
  await db.expense.create({
    data: {
      businessId: business.id,
      supplierId: s1.id,
      category: "Freight",
      amountMinor: 1_200_000,
      paidMinor: 0,
      status: "UNPAID",
      spentAt: daysAgo(30),
      dueDate: daysAgo(4),
      reference: "S1-PAYABLE",
    },
  });
  await db.expense.create({
    data: {
      businessId: business.id,
      supplierId: s2.id,
      category: "Consumables",
      amountMinor: 900_000,
      paidMinor: 0,
      status: "UNPAID",
      spentAt: daysAgo(5),
      reference: "S2-PAYABLE",
    },
  });
  await db.expense.create({
    data: {
      businessId: business.id,
      supplierId: s1.id,
      category: "Freight",
      amountMinor: 500_000,
      paidMinor: 500_000,
      status: "PAID",
      spentAt: daysAgo(40),
    },
  });

  return { user, business, akar };
}

async function cleanup() {
  const user = await db.user.findFirst({ where: { email: EMAIL } });
  if (!user) return;
  const businesses = await db.business.findMany({ where: { ownerId: user.id }, select: { id: true } });
  for (const b of businesses) await db.business.delete({ where: { id: b.id } }); // cascades sales/customers/expenses/membership
  await db.userSession.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  console.log(`cleanup: swept probe user + ${businesses.length} business(es) FK-safe`);
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }

  // Defensive pre-sweep (a previous crashed run may have left the probe user).
  await cleanup();

  const { user, business, akar } = await seed();

  if (process.argv.includes("--keep")) {
    console.log(`KEEP: email=${EMAIL} pass=${PASS} businessId=${business.id} akarId=${akar.id}`);
  }

  try {
    const jar = await login(EMAIL);

    // [A] the all-parties receivables board
    const a = await api(jar, "/api/v1/reports/aging/items?side=receivables", business.id);
    ok("A0. all-parties items 200", a.status === 200, String(a.status));
    const roll = a.body?.data?.summary?.partyRollup;
    ok("A1. partyRollup present on the all-parties view", !!roll);
    const names = (roll?.groups ?? []).map((g: any) => g.partyName);
    ok("A2. ranked: Bahman(2M) > Akar(1.3M) > unassigned(250k) > fillers", JSON.stringify(names.slice(0, 3)) === JSON.stringify(["Bahman Trading", "Akar Industrial", null]), JSON.stringify(names.slice(0, 4)));
    const bahman = roll.groups[0];
    const akarGroup = roll.groups[1];
    const unassigned = roll.groups[2];
    ok("A3. Bahman group exact (count 1 · 2,000,000 · oldest 45)", bahman.count === 1 && bahman.outstandingMinor === 2_000_000 && bahman.oldestDays === 45);
    ok("A4. Akar group exact (count 2 · 1,300,000 · oldest 50)", akarGroup.count === 2 && akarGroup.outstandingMinor === 1_300_000 && akarGroup.oldestDays === 50);
    ok("A5. unassigned group honest (partyId null · 250,000 · oldest 70)", unassigned.partyId === null && unassigned.outstandingMinor === 250_000 && unassigned.oldestDays === 70);
    ok("A6. Chista (PAID) never on the board", !names.includes("Chista Retail"));
    const boardSum = roll.groups.reduce((n: number, g: any) => n + g.outstandingMinor, 0);
    // The board caps at 12 groups: Bahman + Akar + unassigned + the 9 largest
    // fillers (200..192). The 4 capped-out fillers (191+190+189+188 = 758)
    // are the honest remainder — the cap keeps the TOP of the ranking.
    ok("A7. board sum + capped-out remainder (758) === filtered total === full total", boardSum + 758 === a.body.data.summary.filteredTotalOutstandingMinor && a.body.data.summary.filteredTotalOutstandingMinor === a.body.data.summary.totalOutstandingMinor, `${boardSum}+758 vs ${a.body.data.summary.filteredTotalOutstandingMinor}`);
    ok("A8. board item count + 4 capped-out items === filtered item count", roll.groups.reduce((n: number, g: any) => n + g.count, 0) + 4 === a.body.data.summary.filteredOpenItemCount);
    ok("A9. 16 distinct parties (3 main + 13 fillers + unassigned = 16, Chista excluded), untrimmed count, capped list, honest flag", roll.groupCount === 16 && roll.groups.length === 12 && roll.groupsTruncated === true, `count=${roll.groupCount} len=${roll.groups.length}`);
    ok("A10. truncation tail holds the remainder honestly", roll.groupCount - roll.groups.length === 4);

    // [B] the overdue chip lens
    const b = await api(jar, "/api/v1/reports/aging/items?side=receivables&overdue=1", business.id);
    const bRoll = b.body?.data?.summary?.partyRollup;
    ok("B1. overdue board = exactly the breaching party", bRoll?.groups?.length === 1 && bRoll.groups[0].partyName === "Akar Industrial");
    ok("B2. overdue board reconciles with the overdue slice", bRoll.groups[0].outstandingMinor === 1_000_000 && b.body.data.summary.overdueMinor === 1_000_000 && bRoll.groups[0].outstandingMinor === b.body.data.summary.filteredTotalOutstandingMinor);

    // [C] the bucket chip lens (D0_30: young rows only)
    const c = await api(jar, "/api/v1/reports/aging/items?side=receivables&bucket=D0_30", business.id);
    const cRoll = c.body?.data?.summary?.partyRollup;
    const cNames = (cRoll?.groups ?? []).map((g: any) => g.partyName);
    ok("C1. D0_30 board excludes the aged Bahman group", !cNames.includes("Bahman Trading"));
    const cAkar = cRoll.groups.find((g: any) => g.partyName === "Akar Industrial");
    ok("C2. Akar's D0_30 slice = the young invoice only (300,000 · oldest 5)", cAkar && cAkar.outstandingMinor === 300_000 && cAkar.oldestDays === 5);
    ok("C3. D0_30 board sum + capped-out remainder (189+188=377) === filtered total (the cap keeps the TOP)", cRoll.groups.reduce((n: number, g: any) => n + g.outstandingMinor, 0) + 377 === c.body.data.summary.filteredTotalOutstandingMinor, `${cRoll.groups.reduce((n: number, g: any) => n + g.outstandingMinor, 0)}+377 vs ${c.body.data.summary.filteredTotalOutstandingMinor}`);

    // [D] the over-60 union lens
    const d = await api(jar, "/api/v1/reports/aging/items?side=receivables&over60=1", business.id);
    const dRoll = d.body?.data?.summary?.partyRollup;
    ok("D1. over-60 board = the aged unassigned group only", dRoll?.groups?.length === 1 && dRoll.groups[0].partyId === null && dRoll.groups[0].outstandingMinor === 250_000);

    // [E] party-scoped request → honest null
    const e = await api(jar, `/api/v1/reports/aging/items?side=receivables&partyId=${akar.id}`, business.id);
    ok("E1. party-scoped partyRollup is honest NULL", e.status === 200 && e.body?.data?.summary?.partyRollup === null);
    ok("E2. party-scoped rows still exact (2 open Akar invoices)", e.body?.data?.summary?.openItemCount === 2);

    // [F] auth surface unchanged
    const f = await api(new Map(), "/api/v1/reports/aging/items?side=receivables");
    ok("F1. unauthenticated → 401", f.status === 401, String(f.status));

    // [G] the payables side speaks the same board law
    const g = await api(jar, "/api/v1/reports/aging/items?side=payables", business.id);
    const gRoll = g.body?.data?.summary?.partyRollup;
    const gNames = (gRoll?.groups ?? []).map((g2: any) => g2.partyName);
    ok("G1. payables board ranked (Sadaf 1.2M > Kavir 900k)", JSON.stringify(gNames) === JSON.stringify(["Sadaf Logistics", "Kavir Supplies"]), JSON.stringify(gNames));
    ok("G2. Sadaf group exact (1 · 1,200,000 · oldest 4 — the stated-terms ANCHOR law: dueDate ?? spentAt)", gRoll.groups[0].count === 1 && gRoll.groups[0].outstandingMinor === 1_200_000 && gRoll.groups[0].oldestDays === 4, JSON.stringify(gRoll.groups[0]));
    ok("G3. settled Sadaf expense excluded (board count 2)", gRoll.groups.reduce((n: number, g2: any) => n + g2.count, 0) === 2);
    ok("G4. payables board sum reconciles", gRoll.groups.reduce((n: number, g2: any) => n + g2.outstandingMinor, 0) === g.body.data.summary.totalOutstandingMinor);
  } finally {
    // --keep: leave the fixture up for the browser QA session (sweep after
    // with --cleanup — the FIXED email makes the sweep deterministic).
    if (!process.argv.includes("--keep")) await cleanup();
    await db.$disconnect();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:\n" + failures.map((x) => `  - ${x}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("HARNESS ERROR:", err);
  try {
    await cleanup();
  } finally {
    await db.$disconnect();
  }
  process.exit(1);
});

// Module marker — the harness uses top-level await (bun runtime).
export {};

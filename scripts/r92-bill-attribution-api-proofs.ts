/**
 * scripts/r92-bill-attribution-api-proofs.ts — R92 SEEDED API PROOFS (persists).
 *
 * Exercises the REAL HTTP surface (credentials login → session cookie →
 * x-business-id) proving the PAYABLES twin of the copilot's per-party
 * attribution end to end. Every payable is born the LAWFUL way — through
 * the supplier-bill pipeline (PO → GR → draft bill → POST), whose posting
 * creates exactly ONE linked Expense (§11) — so the meta's payables
 * population and the supplier-bills worklist reconcile by construction:
 *
 *   [A] HONEST SILENCE — a fresh business cites NO supplier attribution
 *   [B] THE SEED — Akar Ltd 800k due -10d + Bahar Supply 500k due -20d
 *       (both bill-born) + an ANONYMOUS expense 50k due -2d (walk-in) →
 *       meta cites Akar (800,000); the walk-in counts in the total but is
 *       never attributed
 *   [C] THE DEEP LINKS — the chip's target worklist
 *       (GET /api/v1/supplier-bills?pastDue=1&supplierId=<akar>) is exactly
 *       Akar's bill; the generic past-due worklist carries both bills
 *   [D] THE FLIP — paying the Akar Expense in full moves the attribution
 *       to Bahar by MONEY and the slice follows
 *
 * Run:  bun scripts/r92-bill-attribution-api-proofs.ts
 *       bun scripts/r92-bill-attribution-api-proofs.ts --keep      (leave fixture for browser QA)
 *       bun scripts/r92-bill-attribution-api-proofs.ts --cleanup   (FK-safe sweep)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r92-bill-attribution-probe@qa.local";
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
      "user-agent": "r92-proofs/1.0",
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

type Attribution = {
  id: string;
  name: string;
  count: number;
  outstandingMinor: number;
} | null;

type StreamMeta = {
  counts?: {
    pastDueBills?: number;
    receivablesOverdue?: number;
  };
  topPastDueSupplier?: Attribution;
};

/** POST the REAL grounding stream; the meta SSE frame precedes the model. */
async function readStreamMeta(jar: Map<string, string>, question: string): Promise<{
  status: number;
  meta: StreamMeta | null;
}> {
  const f = jarFetch(jar);
  const res = await f("/api/v1/copilot/stream", {
    method: "POST",
    headers: { "content-type": "application/json", "x-business-id": BIZ_ID },
    body: JSON.stringify({ question, days: 30, history: [] }),
  });
  if (res.status !== 200) return { status: res.status, meta: null };
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((blk) => blk.split("\n").find((l) => l.startsWith("data: "))?.slice(6))
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s as string);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  const metaEvt = events.find((e) => e.meta) as { meta?: StreamMeta } | undefined;
  return { status: res.status, meta: metaEvt?.meta ?? null };
}

async function seed() {
  const passwordHash = await import("bcryptjs").then((m) => m.default.hashSync(PASS, 10));
  const user = await db.user.create({
    data: { email: EMAIL, name: "R92 Bill Attribution Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R92 Bill Attribution Probe Co",
      slug: `r92-bill-attribution-probe-${Date.now().toString(36)}`,
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

/**
 * The LAWFUL payable: PO → line → send → confirm → GR → GR line → GR post
 * → draft bill (with stated terms) → bill line → POST (§11 creates exactly
 * ONE linked Expense with the bill's supplier + dueDate).
 */
async function postPastDueBill(
  jar: Map<string, string>,
  opts: {
    supplierId: string;
    productId: string;
    orderedAt: string;
    qty: number;
    unitPriceMinor: number;
    billDate: string;
    dueDate: string;
  },
): Promise<{ billId: string; expenseId: string; totalMinor: number } | null> {
  const po = await api(jar, "/api/v1/purchase-orders", {
    method: "POST",
    body: JSON.stringify({ supplierId: opts.supplierId, orderedAt: opts.orderedAt }),
  });
  if (po.status !== 201) {
    console.log(`  po failed: ${po.status} ${JSON.stringify(po.body).slice(0, 160)}`);
    return null;
  }
  const line = await api(jar, `/api/v1/purchase-orders/${po.body.id}/lines`, {
    method: "POST",
    body: JSON.stringify({ productId: opts.productId, orderedQty: opts.qty, unitPriceMinor: opts.unitPriceMinor }),
  });
  if (line.status !== 201) {
    console.log(`  po line failed: ${line.status} ${JSON.stringify(line.body).slice(0, 160)}`);
    return null;
  }
  await api(jar, `/api/v1/purchase-orders/${po.body.id}/send`, { method: "POST" });
  const confirmed = await api(jar, `/api/v1/purchase-orders/${po.body.id}/confirm`, { method: "POST" });
  if (confirmed.status !== 200) {
    console.log(`  po confirm failed: ${confirmed.status}`);
    return null;
  }
  const gr = await api(jar, "/api/v1/inventory/goods-receipts", {
    method: "POST",
    body: JSON.stringify({ purchaseOrderId: po.body.id }),
  });
  const grLine = await api(jar, `/api/v1/inventory/goods-receipts/${gr.body.id}/lines`, {
    method: "POST",
    body: JSON.stringify({ purchaseOrderLineId: line.body.id, receivedQty: opts.qty }),
  });
  if (grLine.status !== 201) {
    console.log(`  gr line failed: ${grLine.status} ${JSON.stringify(grLine.body).slice(0, 160)}`);
    return null;
  }
  const grPosted = await api(jar, `/api/v1/inventory/goods-receipts/${gr.body.id}/post`, { method: "POST" });
  if (grPosted.status !== 200) {
    console.log(`  gr post failed: ${grPosted.status}`);
    return null;
  }
  const bill = await api(jar, "/api/v1/supplier-bills", {
    method: "POST",
    body: JSON.stringify({ purchaseOrderId: po.body.id, billDate: opts.billDate, dueDate: opts.dueDate }),
  });
  if (bill.status !== 201) {
    console.log(`  bill draft failed: ${bill.status} ${JSON.stringify(bill.body).slice(0, 160)}`);
    return null;
  }
  const billLine = await api(jar, `/api/v1/supplier-bills/${bill.body.id}/lines`, {
    method: "POST",
    body: JSON.stringify({ purchaseOrderLineId: line.body.id, billedQty: opts.qty, unitPriceMinor: opts.unitPriceMinor }),
  });
  if (billLine.status !== 201) {
    console.log(`  bill line failed: ${billLine.status} ${JSON.stringify(billLine.body).slice(0, 160)}`);
    return null;
  }
  const posted = await api(jar, `/api/v1/supplier-bills/${bill.body.id}/post`, { method: "POST" });
  if (posted.status !== 200 || !posted.body?.expenseId) {
    console.log(`  bill post failed: ${posted.status} ${JSON.stringify(posted.body).slice(0, 160)}`);
    return null;
  }
  return {
    billId: bill.body.id,
    expenseId: posted.body.expenseId,
    totalMinor: posted.body.expenseAmountMinor,
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

    console.log("\n[A] HONEST SILENCE — nothing owed, nobody cited");
    const empty = await readStreamMeta(jar, "What do I owe? (r92 probe phase A)");
    ok("A1 stream 200", empty.status === 200, `got ${empty.status}`);
    ok("A2 meta present", !!empty.meta);
    ok("A3 no supplier attribution on an empty book", empty.meta?.topPastDueSupplier === null, JSON.stringify(empty.meta?.topPastDueSupplier));
    ok("A4 past-due count 0", empty.meta?.counts?.pastDueBills === 0, `got ${empty.meta?.counts?.pastDueBills}`);

    console.log("\n[B] THE SEED — payables born through the bill pipeline");
    const akar = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Akar Ltd" }) });
    ok("B1 Akar Ltd created", akar.status === 201 && !!akar.body?.id, `status ${akar.status}`);
    const akarId = akar.body.id as string;
    const bahar = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Bahar Supply" }) });
    const baharId = bahar.body.id as string;
    ok("B2 Bahar Supply created", bahar.status === 201 && !!baharId);
    const product = await api(jar, "/api/v1/products", {
      method: "POST",
      body: JSON.stringify({ name: "R92 Probe Widget", unit: "pcs", salePriceMinor: 10_000, costPriceMinor: 4_000, stockQty: 500, lowStockAt: 10 }),
    });
    ok("B3 product created", product.status === 201 && !!product.body?.id, `status ${product.status}`);
    const productId = product.body.id as string;

    const bill1 = await postPastDueBill(jar, {
      supplierId: akarId,
      productId,
      orderedAt: tzDayKey(-30),
      qty: 10,
      unitPriceMinor: 80_000,
      billDate: tzDayKey(-25),
      dueDate: tzDayKey(-10),
    });
    ok("B4 BILL1 (Akar, 800k, due -10d) posted with linked Expense", !!bill1 && bill1.totalMinor === 800_000, JSON.stringify(bill1));
    const bill2 = await postPastDueBill(jar, {
      supplierId: baharId,
      productId,
      orderedAt: tzDayKey(-40),
      qty: 5,
      unitPriceMinor: 100_000,
      billDate: tzDayKey(-35),
      dueDate: tzDayKey(-20),
    });
    ok("B5 BILL2 (Bahar, 500k, due -20d) posted with linked Expense", !!bill2 && bill2.totalMinor === 500_000, JSON.stringify(bill2));

    // The ANONYMOUS payable — a bare expense with no supplier (walk-in law).
    const anon = await api(jar, "/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({
        category: "Utilities",
        amountMinor: 50_000,
        spentAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-2),
      }),
    });
    ok("B6 anonymous past-due expense 201", anon.status === 201 && anon.body?.supplierId === null, `status ${anon.status}`);

    const seeded = await readStreamMeta(jar, "What do I owe? (r92 probe phase B)");
    ok("B7 stream 200 (seeded)", seeded.status === 200);
    ok("B8 past-due total = 3 (2 bill-born + 1 anonymous)", seeded.meta?.counts?.pastDueBills === 3, `got ${seeded.meta?.counts?.pastDueBills}`);
    ok("B9 past-due attribution = Akar Ltd (800,000, 1 bill)",
      seeded.meta?.topPastDueSupplier?.id === akarId &&
      seeded.meta?.topPastDueSupplier?.name === "Akar Ltd" &&
      seeded.meta?.topPastDueSupplier?.count === 1 &&
      seeded.meta?.topPastDueSupplier?.outstandingMinor === 800_000,
      JSON.stringify(seeded.meta?.topPastDueSupplier));
    ok("B10 the anonymous payable is honestly NOT attributed (subset law)",
      seeded.meta?.topPastDueSupplier?.count === 1 && seeded.meta?.counts?.pastDueBills === 3);
    ok("B11 slice ≤ total (by construction)", (seeded.meta?.topPastDueSupplier?.count ?? 0) <= (seeded.meta?.counts?.pastDueBills ?? 0));

    console.log("\n[C] THE DEEP LINKS — the chip lands on a lawful worklist");
    const allPastDue = await api(jar, "/api/v1/supplier-bills?pastDue=1");
    ok("C1 generic past-due bills worklist = 2 (both POSTED bills)", allPastDue.status === 200 && allPastDue.body.total === 2, `got ${allPastDue.body?.total}`);
    ok("C2 both bills on it", allPastDue.body.items.some((i: any) => i.id === bill1?.billId) && allPastDue.body.items.some((i: any) => i.id === bill2?.billId));
    const akarBills = await api(jar, `/api/v1/supplier-bills?pastDue=1&supplierId=${akarId}`);
    ok("C3 supplier-scoped worklist = exactly Akar's bill (the chip's target)", akarBills.status === 200 && akarBills.body.total === 1 && akarBills.body.items[0]?.id === bill1?.billId, `got ${akarBills.body?.total}`);
    const foreignBills = await api(jar, `/api/v1/supplier-bills?pastDue=1&supplierId=nonexistent000000000000`);
    ok("C4 foreign supplier → honest empty (closed-token law)", foreignBills.status === 200 && foreignBills.body.total === 0, `got ${foreignBills.status}/${foreignBills.body?.total}`);

    console.log("\n[D] THE FLIP — money decides");
    const pay1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ expenseId: bill1!.expenseId, amountMinor: 800_000, method: "CASH" }),
    });
    ok("D1 Akar Expense paid in full (201)", pay1.status === 201, `got ${pay1.status}`);
    const flipped = await readStreamMeta(jar, "What do I owe now? (r92 probe phase D)");
    ok("D2 past-due total = 2 (the paid Expense left the open population)", flipped.meta?.counts?.pastDueBills === 2, `got ${flipped.meta?.counts?.pastDueBills}`);
    ok("D3 attribution flipped to Bahar Supply (500,000) — money decides",
      flipped.meta?.topPastDueSupplier?.id === baharId &&
      flipped.meta?.topPastDueSupplier?.outstandingMinor === 500_000,
      JSON.stringify(flipped.meta?.topPastDueSupplier));

    console.log("\n[E] GUARDS");
    const anonStream = await fetch(`${BASE}/api/v1/copilot/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x", days: 30, history: [] }),
    });
    ok("E1 unauthenticated stream → 401", anonStream.status === 401, `got ${anonStream.status}`);

    console.log(`\n=== r92-bill-attribution-api-proofs: ${passed} passed, ${failed} failed ===`);
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

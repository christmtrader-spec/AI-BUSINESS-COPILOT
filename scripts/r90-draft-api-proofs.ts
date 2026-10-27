/**
 * scripts/r90-draft-api-proofs.ts — R90 SEEDED API PROOFS (persists).
 *
 * Exercises the REAL HTTP surface (credentials login → session cookie →
 * x-business-id) against the seeded probe business, proving the DRAFT→ISSUE
 * lifecycle END TO END — every document in the matrix is created through
 * the API (never a raw db write), so the proofs test the exact laws a
 * client hits:
 *
 *   [A] create-as-draft — DRAFT, no issue day, no terms; stock still moves
 *       at creation (the documented reserve law); draft-with-terms 422
 *   [B] the receivables silence — open/overdue/outstanding figures are
 *       UNCHANGED by the draft's existence (OPEN_SALE_STATUS_FILTER)
 *   [C] the 360 honesty — money summary counts ISSUED only; the recent
 *       list SHOWS the draft (document vs money)
 *   [D] the worklist laws — status=DRAFT filter, DRAFT∧overdue 422,
 *       overdue=1 still finds exactly the issued breach
 *   [E] the transition locks — dates-on-draft 409, double-issue 409,
 *       payment-on-draft 409
 *   [F] the issue itself — issue+terms (UNPAID, stamped day), issue w/o
 *       terms (honest termless), payment flows after issue, receivables
 *       gain the invoice ONLY at issue
 *   [G] deletion + export — draft deletes cleanly (stock restored), the
 *       export round-trips the draft (backup schema, money-free draft)
 *
 * Run:  bun scripts/r90-draft-api-proofs.ts
 *       bun scripts/r90-draft-api-proofs.ts --keep      (leave fixture for browser QA)
 *       bun scripts/r90-draft-api-proofs.ts --cleanup   (FK-safe sweep)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r90-draft-probe@qa.local";
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

let BIZ_ID = "";

async function seed() {
  const passwordHash = await import("bcryptjs").then((m) => m.default.hashSync(PASS, 10));
  const user = await db.user.create({
    data: { email: EMAIL, name: "R90 Draft Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R90 Draft Probe Co",
      slug: `r90-draft-probe-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: user.id,
      vatEnabled: false,
    },
  });
  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  BIZ_ID = business.id;
  const akar = await db.customer.create({ data: { businessId: business.id, name: "Akar Industrial" } });
  const product = await db.product.create({
    data: {
      businessId: business.id,
      name: "R90 Probe Widget",
      unit: "pcs",
      salePriceMinor: 500_000,
      costPriceMinor: 200_000,
      stockQty: 10,
      lowStockAt: 2,
    },
  });
  return { user, business, akar, product };
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

  const { business, akar, product } = await seed();

  if (process.argv.includes("--keep")) {
    console.log(`KEEP: email=${EMAIL} pass=${PASS} businessId=${business.id} customerId=${akar.id}`);
  }

  try {
    const jar = await login(EMAIL);

    console.log("\n[A] CREATE-AS-DRAFT — through the real POST");
    const issued = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akar.id,
        items: [{ name: "Consulting", qty: 2, unitPriceMinor: 500_000 }],
        // Backdate the issue day (audited) so the stated terms are born
        // VALID — the R81 gate forbids a born-breached invoice — and the
        // due day 3 days ago makes the issued invoice a real breach NOW.
        issueDate: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-3),
      }),
    });
    ok("A1 issued POST 201", issued.status === 201, `got ${issued.status}`);
    const issuedId = issued.body.id;
    ok("A2 issued number = 1", issued.body.number === 1);

    const draft = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akar.id,
        items: [{ productId: product.id, name: "R90 Probe Widget", qty: 1, unitPriceMinor: 500_000 }],
        draft: true,
      }),
    });
    ok("A3 draft POST 201", draft.status === 201, `got ${draft.status}`);
    const draftId = draft.body.id;
    ok("A4 draft consumed the next number (2)", draft.body.number === 2, `got ${draft.body.number}`);

    const draftDetail = await api(jar, `/api/v1/sales/${draftId}`);
    ok("A5 draft detail status DRAFT", draftDetail.body.sale.status === "DRAFT", `got ${draftDetail.body.sale.status}`);
    ok("A6 draft issueDate null (no issue day exists)", draftDetail.body.sale.issueDate === null);
    ok("A7 draft dueDate null (no terms stated)", draftDetail.body.sale.dueDate === null);
    ok("A8 draft never overdue", draftDetail.body.sale.overdue === false);
    ok("A9 draft balance open but pre-money", draftDetail.body.sale.balanceMinor === 500_000);

    const prod = await api(jar, `/api/v1/products/${product.id}`);
    ok("A10 stock STILL moved at creation (the reserve law)", prod.body.inventory.stockQty === 9, `got ${prod.body.inventory?.stockQty}`);

    const withTerms = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [{ name: "x", qty: 1, unitPriceMinor: 100 }],
        draft: true,
        dueDate: tzDayKey(10),
      }),
    });
    ok("A11 draft + dueDate → 422 DRAFT_WITH_TERMS", withTerms.status === 422 && withTerms.body.error?.code === "DRAFT_WITH_TERMS", JSON.stringify(withTerms.body).slice(0, 120));
    const withIssue = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [{ name: "x", qty: 1, unitPriceMinor: 100 }],
        draft: true,
        issueDate: new Date().toISOString(),
      }),
    });
    ok("A12 draft + issueDate → 422 DRAFT_WITH_TERMS", withIssue.status === 422, `got ${withIssue.status}`);

    console.log("\n[B] RECEIVABLES SILENCE — the draft is not money");
    const recv = await api(jar, "/api/v1/receivables");
    ok("B1 outstanding counts the ISSUED invoice only", recv.body.totalOutstandingMinor === 1_000_000, `got ${recv.body.totalOutstandingMinor}`);
    ok("B2 openCount 1 (draft invisible)", recv.body.openCount === 1, `got ${recv.body.openCount}`);
    ok("B3 overdueCount 1 (the breached issued invoice)", recv.body.overdueCount === 1, `got ${recv.body.overdueCount}`);
    ok("B4 receivable items carry no draft", !recv.body.items.some((i: any) => i.id === draftId));

    console.log("\n[C] 360 HONESTY — documents vs money");
    const cust = await api(jar, `/api/v1/customers/${akar.id}`);
    ok("C1 summary invoiceCount 1 (ISSUED only)", cust.body.summary.invoiceCount === 1, `got ${cust.body.summary.invoiceCount}`);
    ok("C2 receivableMinor 1,000,000 (draft excluded)", cust.body.summary.receivableMinor === 1_000_000, `got ${cust.body.summary.receivableMinor}`);
    const draftRecent = cust.body.recentSales.find((r: any) => r.id === draftId);
    ok("C3 recent list SHOWS the draft (document)", !!draftRecent);
    ok("C4 the draft recent row maps honestly", draftRecent && draftRecent.status === "DRAFT" && draftRecent.issueDate === null && draftRecent.dueDate === null && draftRecent.overdue === false);
    ok("C5 overdueSaleCount counts ISSUED breaches only", cust.body.overdueSaleCount === 1, `got ${cust.body.overdueSaleCount}`);

    console.log("\n[D] WORKLIST LAWS");
    const onlyDrafts = await api(jar, "/api/v1/sales?status=DRAFT");
    ok("D1 status=DRAFT → exactly the draft", onlyDrafts.body.total === 1 && onlyDrafts.body.items[0]?.id === draftId);
    ok("D2 the draft row renders honest nulls", onlyDrafts.body.items[0]?.issueDate === null && onlyDrafts.body.items[0]?.overdue === false);
    const draftOverdue = await api(jar, "/api/v1/sales?status=DRAFT&overdue=1");
    ok("D3 DRAFT ∧ overdue → 422 OVERDUE_STATUS_CONFLICT", draftOverdue.status === 422 && draftOverdue.body.error?.code === "OVERDUE_STATUS_CONFLICT", JSON.stringify(draftOverdue.body).slice(0, 120));
    const overdue = await api(jar, "/api/v1/sales?overdue=1");
    ok("D4 overdue=1 finds exactly the issued breach (draft invisible)", overdue.body.total === 1 && overdue.body.items[0]?.id === issuedId, `got ${overdue.body.total}`);

    console.log("\n[E] TRANSITION LOCKS");
    const datesOnDraft = await api(jar, `/api/v1/sales/${draftId}`, {
      method: "PATCH",
      body: JSON.stringify({ dueDate: tzDayKey(10) }),
    });
    ok("E1 dates on a draft (no issue) → 409 SALE_DRAFT_TERMS_AT_ISSUE", datesOnDraft.status === 409 && datesOnDraft.body.error?.code === "SALE_DRAFT_TERMS_AT_ISSUE", JSON.stringify(datesOnDraft.body).slice(0, 140));

    console.log("\n[F] THE ISSUE ITSELF");
    const issueWithTerms = await api(jar, `/api/v1/sales/${draftId}`, {
      method: "PATCH",
      body: JSON.stringify({ issue: true, dueDate: tzDayKey(10) }),
    });
    ok("F1 issue+terms 200", issueWithTerms.status === 200, `got ${issueWithTerms.status}`);
    ok("F2 status flipped to UNPAID (money math owns it now)", issueWithTerms.body.sale.status === "UNPAID");
    ok("F3 issue day STAMPED at issue", typeof issueWithTerms.body.sale.issueDate === "string" && issueWithTerms.body.sale.issueDate.length > 0);
    ok("F4 stated terms ride along", !!issueWithTerms.body.sale.dueDate);
    ok("F5 future due → not overdue", issueWithTerms.body.sale.overdue === false);

    const reIssue = await api(jar, `/api/v1/sales/${draftId}`, {
      method: "PATCH",
      body: JSON.stringify({ issue: true }),
    });
    ok("F6 double issue → 409 SALE_ALREADY_ISSUED", reIssue.status === 409 && reIssue.body.error?.code === "SALE_ALREADY_ISSUED", JSON.stringify(reIssue.body).slice(0, 140));

    const payOnDraft = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: issuedId, amountMinor: 1_000_000, method: "CASH" }),
    });
    ok("F7 payment on the issued invoice works (control)", payOnDraft.status === 201, `got ${payOnDraft.status}`);

    // Second draft: issue WITHOUT terms (honest termless receivable).
    const draft2 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akar.id,
        items: [{ productId: product.id, name: "R90 Probe Widget", qty: 1, unitPriceMinor: 500_000 }],
        draft: true,
      }),
    });
    const draft2Id = draft2.body.id;
    const payBeforeIssue = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: draft2Id, amountMinor: 100_000, method: "CASH" }),
    });
    ok("F8 payment on a DRAFT → 409 SALE_IS_DRAFT", payBeforeIssue.status === 409 && payBeforeIssue.body.error?.code === "SALE_IS_DRAFT", JSON.stringify(payBeforeIssue.body).slice(0, 140));

    const issueTermless = await api(jar, `/api/v1/sales/${draft2Id}`, {
      method: "PATCH",
      body: JSON.stringify({ issue: true }),
    });
    ok("F9 termless issue 200", issueTermless.status === 200);
    ok("F10 termless issue keeps the honest AGING framing", issueTermless.body.sale.dueDate === null && issueTermless.body.sale.overdue === false);
    ok("F11 termless issue still stamps the day", typeof issueTermless.body.sale.issueDate === "string");

    const payAfterIssue = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: draft2Id, amountMinor: 200_000, method: "CASH" }),
    });
    ok("F12 payment flows AFTER issue", payAfterIssue.status === 201, `got ${payAfterIssue.status}`);
    const afterPay = await api(jar, `/api/v1/sales/${draft2Id}`);
    ok("F13 money math owns the issued invoice (PARTIAL)", afterPay.body.sale.status === "PARTIAL" && afterPay.body.sale.paidMinor === 200_000);

    const recv2 = await api(jar, "/api/v1/receivables");
    // F7 settled OV1 in full; the two issued ex-drafts carry 500k + 300k.
    ok("F14 receivables gained BOTH invoices only at issue", recv2.body.openCount === 2 && recv2.body.totalOutstandingMinor === 800_000, `got open ${recv2.body.openCount} total ${recv2.body.totalOutstandingMinor}`);

    console.log("\n[G] DELETION + EXPORT");
    const draft3 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({ items: [{ productId: product.id, name: "R90 Probe Widget", qty: 1, unitPriceMinor: 500_000 }], draft: true }),
    });
    const draft3Id = draft3.body.id;

    const exported = await api(jar, `/api/v1/businesses/${BIZ_ID}/export`);
    const draftRow = exported.body.sales.find((s: any) => s.id === draft3Id);
    ok("G1 export includes the draft document", !!draftRow);
    ok("G2 the export row carries the draft honestly", draftRow && draftRow.status === "DRAFT" && draftRow.issueDate === null);
    const { saleRowSchema } = await import("../src/lib/backup-schema");
    const roundTrip = saleRowSchema.safeParse(draftRow);
    ok("G3 the draft row round-trips the BACKUP SCHEMA", roundTrip.success, roundTrip.success ? "" : JSON.stringify((roundTrip as any).error.issues).slice(0, 160));

    const del = await api(jar, `/api/v1/sales/${draft3Id}`, { method: "DELETE" });
    ok("G4 draft deletes cleanly (no payments)", del.status === 200 && del.body.deleted === true, `got ${del.status}`);
    const prod2 = await api(jar, `/api/v1/products/${product.id}`);
    ok("G5 stock restored on draft delete (10 −1 −1 +1 = 8)", prod2.body.inventory.stockQty === 8, `got ${prod2.body.inventory?.stockQty}`);

    const anon = await fetch(`${BASE}/api/v1/sales`);
    ok("G6 unauthenticated → 401", anon.status === 401, `got ${anon.status}`);

    console.log(`\n=== r90-draft-api-proofs: ${passed} passed, ${failed} failed ===`);
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

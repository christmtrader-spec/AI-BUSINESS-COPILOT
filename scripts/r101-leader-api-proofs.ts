/**
 * scripts/r101-leader-api-proofs.ts — R101 REAL-HTTP PROOFS (persists).
 *
 * Proves the LEADER STRIP round end-to-end over live HTTP — the server's
 * own group order (the extractor's input contract) and the extractor
 * itself FED THE WIRE'S OWN JSON (the exact object the route emitted,
 * passed to the exact function the panel calls):
 *
 *  [A] HONEST SILENCE — a fresh book: perf sales product returns
 *      groups present-and-[] with truncated=false (the client extractor
 *      → null → no strip rendered).
 *  [B] THE SEED (all through the API): 2 catalog products + 1 customer +
 *      1 supplier + 5 invoices + 3 expenses, engineered so the NET rank
 *      DIFFERS from the GROSS rank (Akar Widget gross 1.3M > Bahar 1M,
 *      but Akar's 400k sale-level discount nets it to 900k < Bahar 1M)
 *      and the UNLINKED mass leads the product dimension (walk-in
 *      "Consulting" 2.5M, no productId).
 *  [C] THE WIRE ORDER LAW — the response's groups[0] IS the rank the
 *      panel cites: products crown the unlinked "Consulting" (drill
 *      null); Bahar Gadget (net 1M) outranks Akar Widget (net 900k)
 *      DESPITE the gross order saying otherwise (the rank is NET's);
 *      the groups array is verifiably value-DESC client-side; the
 *      customer leader carries Akar Trading's STABLE id; the expense
 *      category leader is a bare string (no id — the extractor can
 *      never fake a destination); the supplier leader carries its id.
 *  [D] THE EXTRACTOR ON THE WIRE — perfLeaderFact(fetchedJSON) crowns
 *      the expected name/value/total/drill for sales-product,
 *      sales-customer, expenses-category and expenses-supplier —
 *      wire-shape compatibility proven END-TO-END (the panel's exact
 *      call path).
 *  [E] THE WINDOW FLIP — a 7-day window drops the older invoices: the
 *      seed's rank-1 "Consulting" vanishes, the basis shrinks, the
 *      crown moves — the strip follows the window because the fact is
 *      derived from the SAME response, never cached across windows.
 *  [F] THE ADDITIVE LAW — the perf response's top-level key sets are
 *      untouched (sales 8 keys incl. discountBasis; expenses 7; no new
 *      server fields — the fact is a CLIENT extraction of the SAME
 *      response, zero new queries by construction).
 *  [G] 401 — the perf route rejects the unauthenticated.
 *
 * Run: bun --conditions react-server scripts/r101-leader-api-proofs.ts
 *      (--cleanup sweeps the probe; --keep keeps it for browser QA)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r101-leader-probe@qa.local";
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

import { perfLeaderFact } from "../src/lib/perf-leader";

export {};

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": `10.227.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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

const WIDE = { from: tzDayKey(-29), to: tzDayKey(0) };
const NARROW = { from: tzDayKey(-6), to: tzDayKey(0) };
const perfUrl = (kind: string, groupBy: string | null, win: { from: string; to: string }) => {
  const p = new URLSearchParams({ kind, from: win.from, to: win.to });
  if (groupBy) p.set("groupBy", groupBy);
  return `/api/v1/reports/performance?${p.toString()}`;
};

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
    data: { email: EMAIL, name: "R101 Leader Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R101 Leader Probe Co",
      slug: `r101-leader-probe-${Date.now().toString(36)}`,
      timezone: TZ,
      ownerId: user.id,
      vatEnabled: false,
    },
  });
  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  // The perf route enforces ADVANCED_REPORTS server-side — the probe book
  // rides STARTER (the same direct flip the R100 QA used; cache TTL 15s).
  const starter = await db.plan.findFirst({ where: { code: "STARTER" } });
  if (!starter) throw new Error("STARTER plan not seeded");
  await db.subscription.upsert({
    where: { businessId: business.id },
    create: { businessId: business.id, planId: starter.id, status: "ACTIVE" },
    update: { planId: starter.id, status: "ACTIVE" },
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
  console.log(`probe business: ${BIZ_ID} (STARTER)`);

  const jar = await login(EMAIL);

  console.log("\n[A] HONEST SILENCE — a fresh book: groups present-and-EMPTY");
  const fresh = await api(jar, perfUrl("sales", "product", WIDE));
  ok("A1 perf sales product 200 on a fresh book", fresh.status === 200, String(fresh.status));
  ok("A2 groups present-and-[] + truncated=false (the client extractor → null → no strip)",
    Array.isArray(fresh.body?.groups) && fresh.body.groups.length === 0 && fresh.body.truncated === false,
    JSON.stringify(fresh.body?.groups));
  ok("A3 the extractor feeds the fresh response → null (the silence law over the wire)",
    perfLeaderFact(fresh.body, "No customer recorded") === null,
    JSON.stringify(perfLeaderFact(fresh.body, "No customer recorded")));

  console.log("\n[B] THE SEED — the NET rank engineered to DIFFER from the GROSS rank");
  const pAkar = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Akar Widget", salePriceMinor: 800_000, costPriceMinor: 100_000, stockQty: 10 }),
  });
  const pBahar = await api(jar, "/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Bahar Gadget", salePriceMinor: 1_000_000, costPriceMinor: 250_000, stockQty: 10 }),
  });
  const cust = await api(jar, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Akar Trading" }) });
  const supp = await api(jar, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: "Bahar Supply" }) });
  ok("B0 products + customer + supplier created",
    pAkar.status === 201 && pBahar.status === 201 && cust.status === 201 && supp.status === 201,
    `${pAkar.status}/${pBahar.status}/${cust.status}/${supp.status}`);

  // inv1: Akar Widget 800k net (today-10) — Akar gross leg 1
  // inv2: Bahar Gadget 1M net (today-9) — Bahar's whole case
  // inv3: walk-in "Consulting" 2M, NO product (today-8) — the unlinked rank-1
  // inv4: Akar Widget 500k line with a 400k SALE-LEVEL discount (today-5)
  //       → the whole discount lands on the single line → net 100k
  //       → Akar: gross 1.3M but net 900k — the GROSS rank would crown
  //         Akar; the NET rank (the server's law) crowns Bahar.
  // inv5: Akar Trading "Consulting" 2.5M (today-4) — Akar leads customers.
  const mkInvoice = async (body: Record<string, unknown>) =>
    api(jar, "/api/v1/sales", { method: "POST", body: JSON.stringify(body) });
  const inv1 = await mkInvoice({
    customerId: cust.body.id,
    items: [{ productId: pAkar.body.id, name: "Akar Widget", qty: 1, unitPriceMinor: 800_000 }],
    issueDate: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  });
  const inv2 = await mkInvoice({
    customerId: cust.body.id,
    items: [{ productId: pBahar.body.id, name: "Bahar Gadget", qty: 1, unitPriceMinor: 1_000_000 }],
    issueDate: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  });
  const inv3 = await mkInvoice({
    items: [{ name: "Consulting", qty: 1, unitPriceMinor: 2_000_000 }],
    issueDate: new Date(Date.now() - 8 * 86_400_000).toISOString(),
  });
  const inv4 = await mkInvoice({
    customerId: cust.body.id,
    discountMinor: 400_000,
    items: [{ productId: pAkar.body.id, name: "Akar Widget", qty: 1, unitPriceMinor: 500_000 }],
    issueDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  });
  const inv5 = await mkInvoice({
    customerId: cust.body.id,
    items: [{ name: "Consulting", qty: 1, unitPriceMinor: 2_500_000 }],
    issueDate: new Date(Date.now() - 4 * 86_400_000).toISOString(),
  });
  ok("B1 five invoices created", [inv1, inv2, inv3, inv4, inv5].every((r) => r.status === 201),
    [inv1, inv2, inv3, inv4, inv5].map((r) => r.status).join("/"));

  // expenses: Rent 400k (no supplier) > Services 300k (250k on Bahar Supply)
  const e1 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Rent", amountMinor: 400_000, spentAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
  });
  const e2 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Services", amountMinor: 250_000, supplierId: supp.body.id, spentAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
  });
  const e3 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Services", amountMinor: 50_000, spentAt: new Date(Date.now() - 1 * 86_400_000).toISOString() }),
  });
  // e4: Logistics 600k ON Bahar Supply — the supplier leader must be a
  // REAL supplier (850k) over the unassigned mass (Rent 400k + Services
  // 50k = 450k), so both supplier laws get a wire proof: the stable-id
  // drill AND the fallback-name/no-drill rank 2.
  const e4 = await api(jar, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Logistics", amountMinor: 600_000, supplierId: supp.body.id, spentAt: new Date(Date.now() - 1 * 86_400_000).toISOString() }),
  });
  ok("B2 four expenses created", e1.status === 201 && e2.status === 201 && e3.status === 201 && e4.status === 201,
    `${e1.status}/${e2.status}/${e3.status}/${e4.status}`);

  console.log("\n[C] THE WIRE ORDER LAW — groups[0] IS the rank the panel cites");
  const prod = await api(jar, perfUrl("sales", "product", WIDE));
  ok("C0 perf sales product 200 (STARTER entitled)", prod.status === 200, String(prod.status));
  const pg = prod.body?.groups ?? [];
  ok("C1 the UNLINKED mass leads the product dimension: 'Consulting' rank 1, no productId",
    pg[0]?.name === "Consulting" && pg[0]?.productId === null && pg[0]?.kind === "unlinked",
    JSON.stringify(pg[0]));
  ok("C2 THE NET LAW: Bahar Gadget (net 1M) outranks Akar Widget (net 900k) DESPITE gross 1M < 1.3M",
    pg[1]?.name === "Bahar Gadget" && pg[1]?.netValueMinor === 1_000_000 &&
    pg[2]?.name === "Akar Widget" && pg[2]?.netValueMinor === 900_000,
    JSON.stringify(pg.slice(1, 3).map((g: any) => ({ n: g.name, net: g.netValueMinor, gross: g.lineValueMinor }))));
  ok("C3 the groups array is verifiably value-DESC client-side (the extractor's input contract)",
    pg.every((g: any, i: number) => i === 0 || pg[i - 1].netValueMinor >= g.netValueMinor),
    JSON.stringify(pg.map((g: any) => g.netValueMinor)));
  ok("C4 totals on the SAME basis: lineValueMinor 6.8M, discountMinor 400k, netLineValueMinor 6.4M",
    prod.body?.totals?.lineValueMinor === 6_800_000 && prod.body?.totals?.discountMinor === 400_000 &&
    prod.body?.totals?.netLineValueMinor === 6_400_000,
    JSON.stringify(prod.body?.totals));

  const custRes = await api(jar, perfUrl("sales", "customer", WIDE));
  const cg = custRes.body?.groups ?? [];
  // Akar Trading = 800k + 1M + 100k (inv4's net-of-discount TOTAL — the
  // customer revenue basis is the invoice's own totalMinor) + 2.5M = 4.4M.
  ok("C5 the customer leader carries the STABLE id (Akar Trading 4.4M over walk-in 2M)",
    cg[0]?.name === "Akar Trading" && cg[0]?.customerId === cust.body.id && cg[0]?.revenueMinor === 4_400_000,
    JSON.stringify(cg[0]));
  ok("C6 the walk-in mass is rank 2 with a NULL identity (no fake destination possible)",
    cg[1]?.customerId === null && cg[1]?.name === null && cg[1]?.revenueMinor === 2_000_000,
    JSON.stringify(cg[1]));

  const catRes = await api(jar, perfUrl("expenses", "category", WIDE));
  const kag = catRes.body?.groups ?? [];
  ok("C7 the category leader is a BARE STRING (Logistics 600k) — no id field exists at all",
    kag[0]?.category === "Logistics" && kag[0]?.amountMinor === 600_000 && !("categoryId" in kag[0]),
    JSON.stringify(kag[0]));
  const supRes = await api(jar, perfUrl("expenses", "supplier", WIDE));
  const sg = supRes.body?.groups ?? [];
  ok("C8 the supplier leader carries its STABLE id (Bahar Supply 850k over the unassigned 450k)",
    sg[0]?.name === "Bahar Supply" && sg[0]?.supplierId === supp.body.id && sg[0]?.amountMinor === 850_000,
    JSON.stringify(sg[0]));
  ok("C9 the unassigned supplier mass is rank 2 with a NULL identity (no fake destination possible)",
    sg[1]?.supplierId === null && sg[1]?.name === null && sg[1]?.amountMinor === 450_000,
    JSON.stringify(sg[1]));

  console.log("\n[D] THE EXTRACTOR ON THE WIRE — the panel's exact call path");
  const d1 = perfLeaderFact(prod.body, "No customer recorded");
  // inv3 + inv5 are BOTH named "Consulting" with no productId — the same
  // unlinked group: 2M + 2.5M = 4.5M net.
  ok("D1 sales-product wire JSON → the unlinked crown: name Consulting 4.5M, drill NULL",
    d1?.name === "Consulting" && d1?.valueMinor === 4_500_000 && d1?.totalMinor === 6_400_000 && d1?.drill === null,
    JSON.stringify(d1));
  const d2 = perfLeaderFact(custRes.body, "No customer recorded");
  ok("D2 sales-customer wire JSON → Akar Trading 4.4M/6.4M with the stable-id drill",
    d2?.name === "Akar Trading" && d2?.valueMinor === 4_400_000 && d2?.totalMinor === 6_400_000 &&
    JSON.stringify(d2?.drill) === JSON.stringify({ entity: "customer", id: cust.body.id }),
    JSON.stringify(d2));
  const d3 = perfLeaderFact(catRes.body, "No supplier recorded");
  ok("D3 expenses-category wire JSON → Logistics 600k/1.3M, drill ALWAYS null",
    d3?.name === "Logistics" && d3?.valueMinor === 600_000 && d3?.totalMinor === 1_300_000 && d3?.drill === null,
    JSON.stringify(d3));
  const d4 = perfLeaderFact(supRes.body, "No supplier recorded");
  ok("D4 expenses-supplier wire JSON → Bahar Supply 850k/1.3M with the supplier drill",
    d4?.name === "Bahar Supply" && d4?.valueMinor === 850_000 && d4?.totalMinor === 1_300_000 &&
    JSON.stringify(d4?.drill) === JSON.stringify({ entity: "supplier", id: supp.body.id }),
    JSON.stringify(d4));
  const cash = await api(jar, perfUrl("cashflow", null, WIDE));
  ok("D5 the cashflow wire JSON → silence (paged rows never crown)",
    cash.status === 200 && perfLeaderFact(cash.body, "No customer recorded") === null,
    JSON.stringify(perfLeaderFact(cash.body, "No customer recorded")));

  console.log("\n[E] THE WINDOW FLIP — the fact follows the response's window");
  const narrow = await api(jar, perfUrl("sales", "product", NARROW));
  const ng = narrow.body?.groups ?? [];
  ok("E1 the 7-day window drops the older invoices (2 product groups remain: Consulting + Akar)",
    ng.length === 2 && ng[0]?.name === "Consulting" && ng[1]?.name === "Akar Widget",
    JSON.stringify(ng.map((g: any) => g.name)));
  ok("E2 the basis shrinks WITH the window (netLineValueMinor 2.6M)",
    narrow.body?.totals?.netLineValueMinor === 2_600_000,
    String(narrow.body?.totals?.netLineValueMinor));
  ok("E3 the extractor's crown rides the narrowed response (Consulting 2.5M over the 2.6M basis)",
    perfLeaderFact(narrow.body, "No customer recorded")?.valueMinor === 2_500_000 &&
    perfLeaderFact(narrow.body, "No customer recorded")?.totalMinor === 2_600_000,
    JSON.stringify(perfLeaderFact(narrow.body, "No customer recorded")));

  console.log("\n[F] THE ADDITIVE LAW — the perf response's key sets untouched");
  ok("F1 sales response carries EXACTLY its 8 top-level keys (no server-side leader field)",
    JSON.stringify(Object.keys(prod.body).sort()) ===
      JSON.stringify(["discountBasis", "groupBy", "groupTruncated", "groups", "kind", "range", "totals", "truncated"]),
    JSON.stringify(Object.keys(prod.body).sort()));
  ok("F2 expenses response carries EXACTLY its 8 keys",
    JSON.stringify(Object.keys(catRes.body).sort()) ===
      JSON.stringify(["basis", "groupBy", "groupTruncated", "groups", "kind", "range", "totals", "truncated"]),
    JSON.stringify(Object.keys(catRes.body).sort()));
  ok("F3 day/month groupings stay chronological (the client never crowns them)",
    (await api(jar, perfUrl("sales", "day", WIDE))).body?.groups?.[0]?.dimension === "day" &&
    perfLeaderFact(await api(jar, perfUrl("sales", "day", WIDE)).then((r) => r.body), "No customer recorded") === null,
    "day grouping → silence");

  console.log("\n[G] 401 — the perf route rejects the unauthenticated");
  const anon = await fetch(`${BASE}${perfUrl("sales", "product", WIDE)}`, { redirect: "manual" });
  ok("G1 perf 401 without a session", anon.status === 401, String(anon.status));

  console.log(`\n=== r101-leader-api-proofs: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:", failures.join(" | "));
    await cleanup();
    process.exit(1);
  }
  if (!process.argv.includes("--keep")) {
    await cleanup();
  } else {
    console.log(`--keep: probe book left in place for browser QA (business ${BIZ_ID}, user ${EMAIL})`);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  await cleanup();
  process.exit(1);
});

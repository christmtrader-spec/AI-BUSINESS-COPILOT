/**
 * scripts/r91-attribution-api-proofs.ts — R91 SEEDED API PROOFS (persists).
 *
 * Exercises the REAL HTTP surface (credentials login → session cookie →
 * x-business-id) against a seeded probe business, proving the copilot's
 * per-customer ATTRIBUTION end to end — every document is created through
 * the API (never a raw db write), and the meta is read from the REAL
 * grounding stream (POST /api/v1/copilot/stream — the meta event is the
 * FIRST SSE frame, computed before the model says a word):
 *
 *   [A] HONEST SILENCE — a fresh business with no sales cites NO
 *       attribution (topOverdueCustomer/topAgedOver60Customer null)
 *   [B] THE SEED — Akar: INV1 aged∩overdue (70d old, due -65) + INV2
 *       overdue-only; Bahar: INV3 overdue-only; plus a WALK-IN overdue
 *       invoice (no customer) → meta cites exactly WHO owns what
 *   [C] THE DEEP LINKS — the overdue chip's target population
 *       (GET /api/v1/sales?overdue=1&customer=<akar>) is exactly Akar's
 *       slice; the amber chip's target (aging items party+over60) is
 *       exactly INV1 — the chips land on real, lawful worklists
 *   [D] THE FLIP — paying INV1 in full moves the attribution to Bahar
 *       (money decides) and the aged lane goes honestly silent (null)
 *
 * Run:  bun scripts/r91-attribution-api-proofs.ts
 *       bun scripts/r91-attribution-api-proofs.ts --keep      (leave fixture for browser QA)
 *       bun scripts/r91-attribution-api-proofs.ts --cleanup   (FK-safe sweep)
 * Exit: 0 = all green, 1 = at least one failure.
 */

const BASE = "http://localhost:3000";
const EMAIL = "r91-attribution-probe@qa.local";
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
      "x-forwarded-for": `10.220.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
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
    receivablesOverdue?: number;
    agedOver60Invoices?: number;
    pastDueBills?: number;
  };
  topOverdueCustomer?: Attribution;
  topAgedOver60Customer?: Attribution;
};

/**
 * POST the REAL grounding stream and read the meta event. The meta frame
 * is emitted BEFORE the model streams a token — the deterministic server
 * facts, exactly what the client's CitationStrip receives.
 */
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
    data: { email: EMAIL, name: "R91 Attribution Probe", passwordHash, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: "R91 Attribution Probe Co",
      slug: `r91-attribution-probe-${Date.now().toString(36)}`,
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

    console.log("\n[A] HONEST SILENCE — nothing owed, nobody cited");
    const empty = await readStreamMeta(jar, "Who owes me money? (r91 probe phase A)");
    ok("A1 stream 200", empty.status === 200, `got ${empty.status}`);
    ok("A2 meta present", !!empty.meta);
    ok("A3 no overdue attribution on an empty book", empty.meta?.topOverdueCustomer === null, JSON.stringify(empty.meta?.topOverdueCustomer));
    ok("A4 no aged attribution on an empty book", empty.meta?.topAgedOver60Customer === null, JSON.stringify(empty.meta?.topAgedOver60Customer));
    ok("A5 overdue count 0", empty.meta?.counts?.receivablesOverdue === 0, `got ${empty.meta?.counts?.receivablesOverdue}`);

    console.log("\n[B] THE SEED — every document through the API");
    const akar = await api(jar, "/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Akar Trading" }),
    });
    ok("B1 Akar created", akar.status === 201 && !!akar.body?.id, `status ${akar.status}`);
    const akarId = akar.body.id as string;
    const bahar = await api(jar, "/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Bahar Foods" }),
    });
    const baharId = bahar.body.id as string;
    ok("B2 Bahar created", bahar.status === 201 && !!baharId);

    // INV1 — Akar, aged ∩ overdue: issued 70 days ago, due 65 days ago.
    const inv1 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akarId,
        items: [{ name: "Consulting", qty: 2, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 70 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-65),
      }),
    });
    ok("B3 INV1 (Akar aged∩overdue) 201", inv1.status === 201, `got ${inv1.status}`);

    // INV2 — Akar, overdue only: issued 5 days ago, due 3 days ago.
    const inv2 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: akarId,
        items: [{ name: "Setup", qty: 1, unitPriceMinor: 300_000 }],
        issueDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-3),
      }),
    });
    ok("B4 INV2 (Akar overdue-only) 201", inv2.status === 201, `got ${inv2.status}`);

    // INV3 — Bahar, overdue only: issued 30 days ago, due 20 days ago.
    const inv3 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        customerId: baharId,
        items: [{ name: "Delivery", qty: 1, unitPriceMinor: 500_000 }],
        issueDate: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-20),
      }),
    });
    ok("B5 INV3 (Bahar overdue-only) 201", inv3.status === 201, `got ${inv3.status}`);

    // INV4 — WALK-IN (no customer), overdue: the honest non-attributable row.
    const inv4 = await api(jar, "/api/v1/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [{ name: "Counter sale", qty: 1, unitPriceMinor: 50_000 }],
        issueDate: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        dueDate: tzDayKey(-2),
      }),
    });
    ok("B6 INV4 (walk-in overdue) 201", inv4.status === 201, `got ${inv4.status}`);
    const inv4Detail = await api(jar, `/api/v1/sales/${inv4.body.id}`);
    ok("B6b the walk-in carries NO customer (detail customerId/customerName null)",
      inv4Detail.status === 200 && inv4Detail.body.sale.customerId === null && inv4Detail.body.sale.customerName === null,
      `got ${JSON.stringify(inv4Detail.body?.sale?.customerId)}/${JSON.stringify(inv4Detail.body?.sale?.customerName)}`);

    const seeded = await readStreamMeta(jar, "Who owes me money? (r91 probe phase B)");
    ok("B7 stream 200 (seeded)", seeded.status === 200);
    ok("B8 overdue total = 4 (Akar×2 + Bahar×1 + walk-in)", seeded.meta?.counts?.receivablesOverdue === 4, `got ${seeded.meta?.counts?.receivablesOverdue}`);
    ok("B9 aged total = 1 (INV1 only)", seeded.meta?.counts?.agedOver60Invoices === 1, `got ${seeded.meta?.counts?.agedOver60Invoices}`);
    ok("B10 overdue attribution = Akar (2 invoices, 1,300,000)",
      seeded.meta?.topOverdueCustomer?.id === akarId &&
      seeded.meta?.topOverdueCustomer?.name === "Akar Trading" &&
      seeded.meta?.topOverdueCustomer?.count === 2 &&
      seeded.meta?.topOverdueCustomer?.outstandingMinor === 1_300_000,
      JSON.stringify(seeded.meta?.topOverdueCustomer));
    ok("B11 the walk-in is honestly NOT attributed (subset law)",
      seeded.meta?.topOverdueCustomer?.count === 2 && seeded.meta?.counts?.receivablesOverdue === 4);
    ok("B12 aged attribution = Akar (1 invoice, 1,000,000)",
      seeded.meta?.topAgedOver60Customer?.id === akarId &&
      seeded.meta?.topAgedOver60Customer?.count === 1 &&
      seeded.meta?.topAgedOver60Customer?.outstandingMinor === 1_000_000,
      JSON.stringify(seeded.meta?.topAgedOver60Customer));
    ok("B13 slice ≤ total in BOTH lanes (by construction)",
      (seeded.meta?.topOverdueCustomer?.count ?? 0) <= (seeded.meta?.counts?.receivablesOverdue ?? 0) &&
      (seeded.meta?.topAgedOver60Customer?.count ?? 0) <= (seeded.meta?.counts?.agedOver60Invoices ?? 0));

    console.log("\n[C] THE DEEP LINKS — the chips land on lawful worklists");
    const akarWorklist = await api(jar, `/api/v1/sales?overdue=1&customer=${akarId}`);
    ok("C1 overdue∧customer worklist = exactly Akar's slice (2)", akarWorklist.status === 200 && akarWorklist.body.total === 2, `got ${akarWorklist.body?.total}`);
    ok("C2 both Akar invoices on it", akarWorklist.body.items.some((i: any) => i.id === inv1.body.id) && akarWorklist.body.items.some((i: any) => i.id === inv2.body.id));
    const allWorklist = await api(jar, "/api/v1/sales?overdue=1");
    ok("C3 generic overdue worklist = 4 (the generic chip's population)", allWorklist.status === 200 && allWorklist.body.total === 4, `got ${allWorklist.body?.total}`);
    const agedBoard = await api(jar, "/api/v1/reports/aging/items?side=receivables&over60=1&partyId=" + akarId);
    ok("C4 aging board over60∧Akar = exactly INV1", agedBoard.status === 200 && agedBoard.body.items?.length === 1 && agedBoard.body.items[0]?.sourceId === inv1.body.id, `got ${JSON.stringify(agedBoard.body?.items?.map((i: any) => i.reference))}`);
    ok("C5 the board names the party (drill shows WHO)", agedBoard.body.party?.id === akarId && agedBoard.body.party?.name === "Akar Trading", JSON.stringify(agedBoard.body?.party));
    const foreignAging = await api(jar, "/api/v1/reports/aging/items?side=receivables&over60=1&partyId=nonexistent000000000000");
    ok("C6 foreign party on the board → 404 (no existence leak)", foreignAging.status === 404, `got ${foreignAging.status}`);

    console.log("\n[D] THE FLIP — money decides, silence returns");
    const pay1 = await api(jar, "/api/v1/payments", {
      method: "POST",
      body: JSON.stringify({ saleId: inv1.body.id, amountMinor: 1_000_000, method: "CASH" }),
    });
    ok("D1 INV1 paid in full (201)", pay1.status === 201, `got ${pay1.status}`);
    const flipped = await readStreamMeta(jar, "Who owes me money now? (r91 probe phase D)");
    ok("D2 overdue total = 3 (INV1 left the open population)", flipped.meta?.counts?.receivablesOverdue === 3, `got ${flipped.meta?.counts?.receivablesOverdue}`);
    ok("D3 attribution flipped to Bahar (500,000) — money decides",
      flipped.meta?.topOverdueCustomer?.id === baharId &&
      flipped.meta?.topOverdueCustomer?.count === 1 &&
      flipped.meta?.topOverdueCustomer?.outstandingMinor === 500_000,
      JSON.stringify(flipped.meta?.topOverdueCustomer));
    ok("D4 the aged lane went honestly silent (null, not a zero-named chip)",
      flipped.meta?.topAgedOver60Customer === null && flipped.meta?.counts?.agedOver60Invoices === 0,
      JSON.stringify(flipped.meta?.topAgedOver60Customer));

    console.log("\n[E] GUARDS");
    const anon = await fetch(`${BASE}/api/v1/copilot/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x", days: 30, history: [] }),
    });
    ok("E1 unauthenticated stream → 401", anon.status === 401, `got ${anon.status}`);

    console.log(`\n=== r91-attribution-api-proofs: ${passed} passed, ${failed} failed ===`);
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

/**
 * scripts/prompt49-aging-details-cap-check.ts — Prompt 49 ISOLATED cap process.
 *
 * Runs with AGING_DETAIL_SCAN_CAP=60 and AGING_DETAIL_EXPORT_MAX_ROWS=60
 * (NEVER changes the project default 5000) in its OWN process, exercising
 * the REAL detailed-aging domain against the REAL dev database (harness law
 * of the P42–P48 cap checks: shared dev DB, P49CAP-prefixed fixtures,
 * teardown to ZERO including crashed-run recovery):
 *
 *   1. cap env discipline: 60 honored in-process; bogus/below-min/above-max
 *      values clamp per the documented law (child-process probes — module
 *      constants freeze at import);
 *   2. bounded page scan: 80 open sales against a 60 cap → an explicit
 *      pageTruncated page + a VALID next cursor (no silent completeness);
 *   3. bounded summary: summary.truncated=true and totals honestly disclose
 *      the bounded subset;
 *   4. export completeness: 80 matching rows > 60 cap → AgingExportTooLarge
 *      controlled rejection (never a partial CSV), recoverable after cleanup;
 *   5. keyset walk under post-filtering: bucket-filtered pagination across
 *      ALL pages must reproduce EXACTLY the DB-derived bucket membership
 *      (no duplicate, no skipped row — §7.2 cursor = last SCANNED row);
 *   6. same-instant tie-break: two sales at the identical issueDate are
 *      both returned exactly once across pages (deterministic id ordering);
 *   7. paid invoices vanish from the open-item walk (0-balance guard);
 *   8. teardown to ZERO residue + integrity probes.
 *
 * Run: AGING_DETAIL_SCAN_CAP=60 AGING_DETAIL_EXPORT_MAX_ROWS=60 \
 *      bun --preload ./scripts/lib/register-server-only-shim.ts \
 *      scripts/prompt49-aging-details-cap-check.ts
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  buildAgingDetailPage,
  buildAgingDetailSummary,
  collectAgingDetailRows,
  AgingExportTooLargeError,
  AGING_DETAIL_SCAN_CAP,
  AGING_DETAIL_EXPORT_MAX_ROWS,
} from "../src/lib/aging-details";
import { agingBucketForAge, localDayIndex } from "../src/lib/aging";

const db = new PrismaClient();
const TAG = "P49CAP";
const STAMP = `${Date.now()}`.slice(-8);
const TZ = "UTC";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, info = "") {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
    console.log(`✗ ${name}${info ? " — " + info : ""}`);
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
  const users = await db.user.findMany({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } }, select: { id: true } });
  for (const u of users) {
    await db.userSession.deleteMany({ where: { userId: u.id } });
    await db.auditLog.deleteMany({ where: { actorId: u.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  }
}

/** Child-process probe: module constants freeze at import → probe fresh envs. */
function probeCap(envValue: string | undefined, varName: string): number {
  const env = { ...process.env };
  if (envValue === undefined) delete env[varName];
  else env[varName] = envValue;
  const out = execSync(
    `bun --preload ./scripts/lib/register-server-only-shim.ts -e 'import("./src/lib/aging-details.ts").then(m => console.log(JSON.stringify([m.AGING_DETAIL_SCAN_CAP, m.AGING_DETAIL_EXPORT_MAX_ROWS])))'`,
    { env, cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  const arr = JSON.parse(out.split("\n").pop() ?? "[0,0]") as number[];
  return varName === "AGING_DETAIL_SCAN_CAP" ? arr[0] : arr[1];
}

async function main() {
  await purge();
  const prior = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  ok("0.1 no prior P49CAP residue", prior === 0);

  /* ------------------------- 1. cap env discipline ------------------------- */
  section("1. cap env discipline (documented 5000 default + sane clamps)");
  ok("1.1 in-process env honored (60/60)", AGING_DETAIL_SCAN_CAP === 60 && AGING_DETAIL_EXPORT_MAX_ROWS === 60, `${AGING_DETAIL_SCAN_CAP}/${AGING_DETAIL_EXPORT_MAX_ROWS}`);
  ok("1.2 unset → documented default 5000", probeCap(undefined, "AGING_DETAIL_SCAN_CAP") === 5000);
  ok("1.3 garbage → documented default", probeCap("not-a-number", "AGING_DETAIL_SCAN_CAP") === 5000);
  ok("1.4 below-min clamps to 20 (bound never disabled)", probeCap("1", "AGING_DETAIL_SCAN_CAP") === 20);
  ok("1.5 above-max clamps to 200000", probeCap("99999999", "AGING_DETAIL_SCAN_CAP") === 200000);
  ok("1.6 export cap clamps identically", probeCap("5", "AGING_DETAIL_EXPORT_MAX_ROWS") === 20);

  /* ----------------------------- 2. fixtures ------------------------------- */
  section("2. fixtures (real dev DB, P49CAP-prefixed)");
  const bcrypt = (await import("bcryptjs")).default;
  const user = await db.user.create({
    data: {
      email: `${TAG.toLowerCase()}-owner-${STAMP}@p49cap.test`,
      name: `${TAG} owner`,
      passwordHash: bcrypt.hashSync("P49CAP!Passw0rd!1", 4),
      locale: "en",
    },
  });
  const biz = await db.business.create({
    data: {
      name: `${TAG}-A-${STAMP}`,
      slug: `${TAG.toLowerCase()}-a-${STAMP}`,
      ownerId: user.id,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      timezone: TZ,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  const customer = await db.customer.create({
    data: { businessId: biz.id, name: `${TAG} Cap Customer`, phone: null },
  });

  // 80 open sales: ages spread across the four buckets, all distinct instants.
  const AGE_PLAN = [
    ...Array.from({ length: 20 }, (_, i) => 1 + i),        // 1..20  → D0_30
    ...Array.from({ length: 20 }, (_, i) => 31 + i),       // 31..50 → D31_60
    ...Array.from({ length: 20 }, (_, i) => 61 + i),       // 61..80 → D61_90
    ...Array.from({ length: 20 }, (_, i) => 91 + i),       // 91..110 → D90_PLUS
  ];
  let numberSeq = 1;
  const salesData = AGE_PLAN.map((age) => ({
    businessId: biz.id,
    customerId: customer.id,
    number: numberSeq++,
    subtotalMinor: 1000,
    discountMinor: 0,
    totalMinor: 1000,
    paidMinor: 0,
    status: "UNPAID",
    issueDate: daysAgo(age),
  }));
  await db.sale.createMany({ data: salesData });

  // Two PAID sales (0 balance) — the open guard must skip them everywhere.
  await db.sale.createMany({
    data: [1, 2].map((i) => ({
      businessId: biz.id,
      customerId: customer.id,
      number: numberSeq++,
      subtotalMinor: 500,
      discountMinor: 0,
      totalMinor: 500,
      paidMinor: 500,
      status: "PAID",
      issueDate: daysAgo(i),
    })),
  });

  const now = new Date();
  const todayIdx = localDayIndex(now, TZ);

  /* ------------------------- 3. bounded page scan -------------------------- */
  section("3. bounded page scan (cap 60 < 82 source rows)");
  const page1 = await buildAgingDetailPage({
    side: "receivables",
    businessId: biz.id,
    partyId: null,
    bucket: null,
    pastDue: false,
    timeZone: TZ,
    now,
    limit: 100,
    cursor: null,
  });
  ok("3.1 page hits the scan cap explicitly (pageTruncated, never silent)", page1.pageTruncated === true);
  ok("3.2 page returns items despite truncation (partial page is HONEST)", page1.items.length > 0 && page1.items.length <= 100);
  ok("3.3 a valid next cursor exists when the cap stops the walk", typeof page1.nextCursor === "string" && page1.nextCursor.length > 0);
  ok("3.4 paid invoices excluded from the page", page1.items.every((i) => i.outstandingMinor > 0));

  const summary1 = await buildAgingDetailSummary({
    side: "receivables",
    businessId: biz.id,
    partyId: null,
    bucket: null,
    pastDue: false,
    timeZone: TZ,
    now,
    limit: 0,
    cursor: null,
  });
  ok("3.5 summary discloses the bounded subset (truncated=true)", summary1.truncated === true);
  ok("3.6 summary counts ≤ the cap open items", summary1.openItemCount <= 60 && summary1.openItemCount > 0);
  ok("3.7 summary buckets stay the closed 4-bucket shape", summary1.buckets.length === 4 && summary1.buckets.every((b) => Number.isInteger(b.minor) && Number.isInteger(b.count)));
  ok("3.8 asOf is the business-local day key", summary1.asOf.length === 10 && summary1.timezone === TZ);

  /* ------------------------ 4. export completeness ------------------------- */
  section("4. export completeness (80 matching rows > 60 cap → reject)");
  let tooLarge = false;
  try {
    await collectAgingDetailRows({
      side: "receivables",
      businessId: biz.id,
      partyId: null,
      bucket: null,
      pastDue: false,
      timeZone: TZ,
      now,
      limit: 0,
      cursor: null,
    });
  } catch (error) {
    tooLarge = error instanceof AgingExportTooLargeError;
  }
  ok("4.1 over-cap export rejects with the controlled error", tooLarge);
  ok("4.2 the controlled error is a stable Error instance", (() => {
    const e = new AgingExportTooLargeError(60);
    return e instanceof Error && e.name === "AgingExportTooLargeError" && e.cap === 60;
  })());

  // Narrow to one bucket (20 matching rows ≤ 60) → the export SUCCEEDS complete.
  const bucketRows = await collectAgingDetailRows({
    side: "receivables",
    businessId: biz.id,
    partyId: null,
    bucket: "D31_60",
    pastDue: false,
    timeZone: TZ,
    now,
    limit: 0,
    cursor: null,
  });
  const expectedBucket = AGE_PLAN.filter((a) => agingBucketForAge(todayIdx - localDayIndex(daysAgo(a), TZ)) === "D31_60").length;
  ok("4.3 narrowed export completes for its declared scope", bucketRows.length === expectedBucket, `got ${bucketRows.length}, want ${expectedBucket}`);
  ok("4.4 narrowed export rows all carry the requested bucket", bucketRows.every((r) => r.bucket === "D31_60"));

  /* --------------------- 5. keyset walk under filtering -------------------- */
  section("5. keyset walk under post-filtering (no dup / no skip)");
  // Walk the D31_60 bucket page-by-page (limit 6 → multiple pages) and
  // compare the union with the DB-derived membership.
  const walked: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  for (;;) {
    const page = await buildAgingDetailPage({
      side: "receivables",
      businessId: biz.id,
      partyId: customer.id,
      bucket: "D31_60",
      pastDue: false,
      timeZone: TZ,
      now,
      limit: 6,
      cursor,
    });
    walked.push(...page.items.map((i) => i.sourceId));
    if (!page.nextCursor || guard++ > 50) break;
    cursor = page.nextCursor;
  }
  const dbBucketIds = new Set(
    (
      await db.sale.findMany({
        where: { businessId: biz.id, deletedAt: null, status: { not: "PAID" }, customerId: customer.id },
        select: { id: true, issueDate: true, totalMinor: true, paidMinor: true },
      })
    )
      .filter((s) => s.totalMinor - s.paidMinor > 0)
      .filter((s) => agingBucketForAge(todayIdx - localDayIndex(s.issueDate, TZ)) === "D31_60")
      .map((s) => s.id),
  );
  ok("5.1 walked union == DB bucket membership (no skip)", dbBucketIds.size === walked.length && walked.every((id) => dbBucketIds.has(id)), `walked ${walked.length}, db ${dbBucketIds.size}`);
  ok("5.2 no duplicate row across pages", new Set(walked).size === walked.length);

  // Full (unfiltered) cursor walk must complete the WHOLE open scope: the
  // scan cap bounds ONE request (§7.2), while cursor pagination legitimately
  // walks the remaining scope page by page — never losing rows.
  const walkedAll: string[] = [];
  cursor = null;
  guard = 0;
  for (;;) {
    const page = await buildAgingDetailPage({
      side: "receivables",
      businessId: biz.id,
      partyId: null,
      bucket: null,
      pastDue: false,
      timeZone: TZ,
      now,
      limit: 7,
      cursor,
    });
    walkedAll.push(...page.items.map((i) => i.sourceId));
    if (!page.nextCursor || guard++ > 100) break;
    cursor = page.nextCursor;
  }
  const dbOpenIds = new Set(
    (
      await db.sale.findMany({
        where: { businessId: biz.id, deletedAt: null, status: { not: "PAID" }, customerId: customer.id },
        select: { id: true, totalMinor: true, paidMinor: true },
      })
    )
      .filter((s) => s.totalMinor - s.paidMinor > 0)
      .map((s) => s.id),
  );
  ok("5.3 cursor walk completes the WHOLE open scope (80) despite the per-request cap", walkedAll.length === dbOpenIds.size && walkedAll.length === 80, `walked ${walkedAll.length}, db ${dbOpenIds.size}`);
  ok("5.4 walked union == DB open membership (no skip)", walkedAll.every((id) => dbOpenIds.has(id)));
  ok("5.5 capped walk still has zero duplicates", new Set(walkedAll).size === walkedAll.length);

  /* ------------------------- 6. same-instant tie-break --------------------- */
  section("6. same-instant tie-break (deterministic (ts,id) order)");
  const sameInstant = new Date("2026-05-05T10:00:00.000Z");
  await db.sale.createMany({
    data: [1, 2, 3].map((i) => ({
      businessId: biz.id,
      customerId: customer.id,
      number: numberSeq++,
      subtotalMinor: 700 + i,
      discountMinor: 0,
      totalMinor: 700 + i,
      paidMinor: 0,
      status: "UNPAID",
      issueDate: sameInstant,
    })),
  });
  const tiePage = await buildAgingDetailPage({
    side: "receivables",
    businessId: biz.id,
    partyId: customer.id,
    bucket: null,
    pastDue: false,
    timeZone: TZ,
    now: new Date(sameInstant.getTime() + 86_400_000),
    limit: 2,
    cursor: null,
  });
  const tieWalk: string[] = [];
  cursor = null;
  guard = 0;
  let tieSum = 0;
  for (;;) {
    const page = await buildAgingDetailPage({
      side: "receivables",
      businessId: biz.id,
      partyId: customer.id,
      bucket: null,
      pastDue: false,
      timeZone: TZ,
      now: new Date(sameInstant.getTime() + 86_400_000),
      limit: 2,
      cursor,
    });
    tieWalk.push(...page.items.filter((i) => i.totalMinor >= 701 && i.totalMinor <= 703).map((i) => i.sourceId));
    tieSum += page.items.filter((i) => i.totalMinor >= 701 && i.totalMinor <= 703).length;
    if (!page.nextCursor || guard++ > 60) break;
    cursor = page.nextCursor;
  }
  ok("6.1 all three same-instant rows returned exactly once across pages", tieSum === 3 && new Set(tieWalk).size === 3, `sum ${tieSum} unique ${new Set(tieWalk).size}`);
  ok("6.2 tie page ordering is deterministic (ts asc, then id asc)", (() => {
    const keys = tiePage.items.map((i) => `${i.documentDate}:${i.sourceId}`);
    return JSON.stringify(keys) === JSON.stringify([...keys].sort());
  })());

  /* --------------------------- 7. teardown --------------------------------- */
  section("7. teardown to ZERO residue");
  await purge();
  const bizLeft = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  const userLeft = await db.user.count({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } } });
  const saleLeft = await db.sale.count({ where: { businessId: biz.id } });
  const expenseLeft = await db.expense.count({ where: { businessId: biz.id } });
  ok("7.1 no fixture business remains", bizLeft === 0);
  ok("7.2 no fixture user remains", userLeft === 0);
  ok("7.3 no fixture sale remains", saleLeft === 0);
  ok("7.4 no fixture expense remains", expenseLeft === 0);
  const quick = await db.$queryRawUnsafe<Array<{ quick_check: string }>>("PRAGMA quick_check");
  const fk = await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
  ok("7.5 SQLite quick_check ok", quick[0]?.quick_check === "ok");
  ok("7.6 foreign_key_check clean", fk.length === 0);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error("FATAL:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

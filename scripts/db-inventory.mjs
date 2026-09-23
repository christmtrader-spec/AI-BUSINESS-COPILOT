// Prompt 19 — read-only database inventory + integrity probe.
// Usage: bun scripts/db-inventory.mjs <dbPath> <outJsonPath>
// Captures: integrity results, per-model row counts, relationship sanity
// checks and per-business aggregates. NEVER dumps record contents — counts
// and structural results only (no PII leaves the database).

import { Database } from "bun:sqlite";

const [dbPath, outPath] = process.argv.slice(2);
if (!dbPath || !outPath) {
  console.error("usage: bun scripts/db-inventory.mjs <dbPath> <outJsonPath>");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });

// --- §4 integrity -----------------------------------------------------------
const integrity = db.query("PRAGMA integrity_check").all().map((r) => r.integrity_check);
const quickCheck = db.query("PRAGMA quick_check").all().map((r) => r.quick_check);
const fkViolations = db.query("PRAGMA foreign_key_check").all();

// --- §5 row counts ----------------------------------------------------------
const MODELS = [
  "User",
  "Business",
  "BusinessMember",
  "BusinessInvite",
  "AuditLog",
  "Customer",
  "Supplier",
  "Product",
  "InventoryAdjustment",
  "Sale",
  "SaleItem",
  "Expense",
  "Payment",
  "ChatSession",
  "ChatMessage",
  "PasswordResetToken",
];

const counts = {};
for (const t of MODELS) {
  counts[t] = db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
}

// --- §5 relationship sanity (orphan detection) ------------------------------
const q1 = (sql) => db.query(sql).get().n;
const relationships = {
  business_ownerId_dangling: q1(
    `SELECT COUNT(*) AS n FROM Business b LEFT JOIN User u ON u.id = b.ownerId WHERE u.id IS NULL`,
  ),
  member_businessId_dangling: q1(
    `SELECT COUNT(*) AS n FROM BusinessMember m LEFT JOIN Business b ON b.id = m.businessId WHERE b.id IS NULL`,
  ),
  member_userId_dangling: q1(
    `SELECT COUNT(*) AS n FROM BusinessMember m LEFT JOIN User u ON u.id = m.userId WHERE u.id IS NULL`,
  ),
  saleItem_saleId_dangling: q1(
    `SELECT COUNT(*) AS n FROM SaleItem si LEFT JOIN Sale s ON s.id = si.saleId WHERE s.id IS NULL`,
  ),
  payment_invalid_target: q1(
    `SELECT COUNT(*) AS n FROM Payment p
     LEFT JOIN Sale s ON s.id = p.saleId
     LEFT JOIN Expense e ON e.id = p.expenseId
     WHERE (p.saleId IS NULL AND p.expenseId IS NULL)
        OR (p.saleId IS NOT NULL AND s.id IS NULL)
        OR (p.expenseId IS NOT NULL AND e.id IS NULL)
        OR (p.saleId IS NOT NULL AND p.expenseId IS NOT NULL)`,
  ),
  payment_businessId_mismatch: q1(
    `SELECT COUNT(*) AS n FROM Payment p
     LEFT JOIN Sale s ON s.id = p.saleId
     LEFT JOIN Expense e ON e.id = p.expenseId
     WHERE (s.id IS NOT NULL AND s.businessId <> p.businessId)
        OR (e.id IS NOT NULL AND e.businessId <> p.businessId)`,
  ),
  passwordResetToken_userId_dangling: q1(
    `SELECT COUNT(*) AS n FROM PasswordResetToken t LEFT JOIN User u ON u.id = t.userId WHERE u.id IS NULL`,
  ),
};

// --- §39 per-business aggregates (before/after comparison) ------------------
const perBusiness = db
  .query(
    `SELECT b.id AS businessId,
       (SELECT COUNT(*) FROM BusinessMember m WHERE m.businessId = b.id) AS members,
       (SELECT COUNT(*) FROM Customer c WHERE c.businessId = b.id) AS customers,
       (SELECT COUNT(*) FROM Product p WHERE p.businessId = b.id) AS products,
       (SELECT COUNT(*) FROM Sale s WHERE s.businessId = b.id) AS sales,
       (SELECT COUNT(*) FROM Expense e WHERE e.businessId = b.id) AS expenses,
       (SELECT COUNT(*) FROM Payment p2 WHERE p2.businessId = b.id) AS payments,
       (SELECT COUNT(*) FROM ChatSession cs WHERE cs.businessId = b.id) AS chatSessions
     FROM Business b ORDER BY b.id`,
  )
  .all();

const perOwner = db
  .query(
    `SELECT ownerId AS userId, COUNT(*) AS businesses FROM Business GROUP BY ownerId ORDER BY ownerId`,
  )
  .all();

// money totals (integer minor units) — must never change from migration work
const money = {
  saleTotalMinor: q1(`SELECT COALESCE(SUM(totalMinor),0) AS n FROM Sale`),
  salePaidMinor: q1(`SELECT COALESCE(SUM(paidMinor),0) AS n FROM Sale`),
  expenseAmountMinor: q1(`SELECT COALESCE(SUM(amountMinor),0) AS n FROM Expense`),
  expensePaidMinor: q1(`SELECT COALESCE(SUM(paidMinor),0) AS n FROM Expense`),
  paymentInMinor: q1(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amountMinor ELSE 0 END),0) AS n FROM Payment`),
  paymentOutMinor: q1(`SELECT COALESCE(SUM(CASE WHEN direction='OUT' THEN amountMinor ELSE 0 END),0) AS n FROM Payment`),
};

const migrationTables = db
  .query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migration%'`)
  .all()
  .map((r) => r.name);

const result = {
  capturedAt: new Date().toISOString(),
  dbPath,
  fileSizeBytes: (await Bun.file(dbPath).size) ?? null,
  integrity,
  quickCheck,
  foreignKeyViolations: fkViolations,
  counts,
  relationships,
  perBusiness,
  perOwner,
  money,
  migrationTables,
};

await Bun.write(outPath, JSON.stringify(result, null, 2));
console.log(`inventory written: ${outPath}`);
console.log(`integrity: ${integrity.join(",")} | quick: ${quickCheck.join(",")} | fk violations: ${fkViolations.length}`);
console.log(`counts: ${JSON.stringify(counts)}`);
db.close();

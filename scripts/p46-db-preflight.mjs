// PROMPT 46 — Phase 0 safety preflight: read-only DB inspection.
// Never prints record contents — structural facts only (no PII).
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });

console.log("=== TABLES ===");
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_migrations' ORDER BY name").all().map(r => r.name);
console.log(tables.join(", "));
console.log(`total: ${tables.length}`);

console.log("\n=== AnalyticsEvent / ContactLead presence ===");
console.log("AnalyticsEvent table:", tables.includes("AnalyticsEvent") ? "EXISTS" : "ABSENT");
console.log("ContactLead table:", tables.includes("ContactLead") ? "EXISTS" : "ABSENT");

console.log("\n=== Business columns ===");
const bizCols = db.query("PRAGMA table_info(Business)").all().map(c => c.name);
console.log(bizCols.join(", "));
console.log("onboardingCompletedAt:", bizCols.includes("onboardingCompletedAt") ? "EXISTS" : "ABSENT");
console.log("onboardingDismissedAt:", bizCols.includes("onboardingDismissedAt") ? "EXISTS" : "ABSENT");

console.log("\n=== CommercialEvent presence ===");
console.log("CommercialEvent table:", tables.includes("CommercialEvent") ? "EXISTS" : "ABSENT");
if (tables.includes("CommercialEvent")) {
  console.log("CommercialEvent row count:", db.query("SELECT COUNT(*) n FROM CommercialEvent").get().n);
}

console.log("\n=== MIGRATION LEDGER ===");
const ledger = db.query("SELECT migration_name, finished_at IS NOT NULL AS finished, applied_steps_count, logs FROM _prisma_migrations ORDER BY started_at").all();
for (const r of ledger) {
  console.log(`${r.migration_name} | finished=${r.finished} | steps=${r.applied_steps_count}${r.logs ? " | logs=" + String(r.logs).slice(0, 80) : ""}`);
}
console.log(`ledger rows: ${ledger.length}, finished: ${ledger.filter(r => r.finished).length}`);

console.log("\n=== INTEGRITY ===");
console.log("quick_check:", db.query("PRAGMA quick_check").all().map(r => Object.values(r)[0]).join(","));
const fk = db.query("PRAGMA foreign_key_check").all();
console.log("foreign_key_check violations:", fk.length);

db.close();

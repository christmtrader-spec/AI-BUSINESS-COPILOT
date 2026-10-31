// R167 opening census — sandbox revert archaeology (readonly, no writes).
import { Database } from "bun:sqlite";

const db = new Database("db/custom.db", { readonly: true });
const q = (sql) => db.prepare(sql).all();
const one = (sql) => db.prepare(sql).get();

const cols = q("PRAGMA table_info(User)").map((c) => c.name);
console.log("user columns:", JSON.stringify(cols));
console.log("users:", JSON.stringify(q("SELECT * FROM User ORDER BY createdAt LIMIT 10").map((u) => ({ email: u.email, role: u.role ?? u.userRole ?? "?" }))));
console.log("biz:", JSON.stringify(q("SELECT id, name FROM Business")));
console.log(
  "sales/expenses/products:",
  one("SELECT COUNT(*) c FROM Sale").c,
  one("SELECT COUNT(*) c FROM Expense").c,
  one("SELECT COUNT(*) c FROM Product").get ? one("SELECT COUNT(*) c FROM Product").c : one("SELECT COUNT(*) c FROM Product").c,
);
console.log("expense cats:", JSON.stringify(q("SELECT category, COUNT(*) c FROM Expense GROUP BY category ORDER BY c DESC")));

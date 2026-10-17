// One-off QA probe: dump billing state relevant to the business-creation limiter.
// Usage: bun scripts/qa/inspect-billing-state.mjs
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const plans = await db.plan.findMany({
  select: {
    code: true,
    active: true,
    isPublic: true,
    sortOrder: true,
    planEntitlements: { select: { value: true, boolValue: true, entitlement: { select: { code: true } } } },
  },
  orderBy: { sortOrder: "asc" },
});

console.log("--- PLANS (BUSINESSES_MAX / CSV_EXPORT) ---");
for (const p of plans) {
  const be = p.planEntitlements.find((pe) => pe.entitlement.code === "BUSINESSES_MAX");
  const csv = p.planEntitlements.find((pe) => pe.entitlement.code === "CSV_EXPORT");
  console.log(
    `${p.code.padEnd(12)} active=${p.active} isPublic=${p.isPublic} ` +
      `BUSINESSES_MAX=${be ? String(be.value) : "MISSING"} CSV_EXPORT=${csv ? String(csv.boolValue) : "MISSING"}`
  );
}

console.log("--- USERS ---");
const users = await db.user.findMany({ select: { id: true, email: true, name: true, createdAt: true } });
for (const u of users) {
  const owned = await db.business.count({ where: { ownerId: u.id } });
  console.log(`${u.email} (${u.name ?? "?"}) owned=${owned} id=${u.id.slice(0, 12)}`);
}

console.log("--- BUSINESSES ---");
const biz = await db.business.findMany({ select: { id: true, name: true, ownerId: true, createdAt: true } });
console.log("total:", biz.length);
for (const b of biz) {
  const sub = await db.subscription.findUnique({ where: { businessId: b.id }, select: { plan: { select: { code: true } }, status: true } });
  console.log(`${b.name} owner=${b.ownerId.slice(0, 12)} plan=${sub ? `${sub.plan.code}/${sub.status}` : "NO SUB"}`);
}

await db.$disconnect();

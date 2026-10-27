/**
 * R71 read-only inspection #2: operator state for the user's account +
 * setup key row detail. NEVER mutates anything.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const user = await db.user.findUnique({
  where: { email: "admiin@gmail.com" },
  select: { id: true, email: true, name: true, createdAt: true },
});
console.log("USER:", JSON.stringify(user, null, 2));

if (user) {
  const ops = await db.platformOperator.findMany({
    where: { userId: user.id },
    select: { id: true, role: true, isActive: true, mfaEnabledAt: true, createdAt: true },
  });
  console.log("OPERATOR ROWS:", JSON.stringify(ops, null, 2));
}

const keys = await db.platformSetupKey.findMany({});
console.log("SETUP KEY RAW ROW:", JSON.stringify(keys, null, 2));

const events = await db.platformAuditEvent.findMany({
  where: { OR: [{ action: { contains: "SETUP" } }, { action: { contains: "OPERATOR" } }] },
  orderBy: { createdAt: "desc" },
  take: 10,
  select: { action: true, createdAt: true, actorLabel: true, metadata: true },
});
console.log("RECENT SETUP/OPERATOR AUDIT EVENTS:");
for (const e of events) console.log(`${e.createdAt.toISOString()} | ${e.action} | ${e.actorLabel ?? "-"} | ${e.metadata?.slice(0, 120) ?? "-"}`);

await db.$disconnect();

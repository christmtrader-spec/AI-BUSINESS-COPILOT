/**
 * R71 read-only inspection: list users + setup key status to diagnose
 * the reported registration failure. NEVER mutates anything.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const users = await db.user.findMany({
  select: { email: true, name: true, createdAt: true, emailVerifiedAt: true },
  orderBy: { createdAt: "desc" },
  take: 15,
});
console.log("=== USERS (latest 15) ===");
for (const u of users) {
  console.log(`${u.email} | ${u.name ?? "-"} | created=${u.createdAt.toISOString()} | verified=${u.emailVerifiedAt ? "yes" : "no"}`);
}

const keys = await db.platformSetupKey.findMany({
  select: { id: true, boundEmail: true, usedAt: true, expiresAt: true, createdAt: true },
});
console.log("=== PLATFORM SETUP KEYS ===");
for (const k of keys) {
  console.log(`${k.id} | bound=${k.boundEmail ?? "-"} | used=${k.usedAt?.toISOString() ?? "pending"} | expires=${k.expiresAt.toISOString()}`);
}

const count = await db.user.count();
console.log(`TOTAL_USERS=${count}`);
await db.$disconnect();

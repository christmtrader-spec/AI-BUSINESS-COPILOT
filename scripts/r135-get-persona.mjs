import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const u = await db.user.findFirst({ where: { email: { startsWith: "r131-qa-" } }, orderBy: { createdAt: "desc" } });
const b = await db.business.findFirst({ where: { name: { startsWith: "R131 QA Ventures" } }, orderBy: { createdAt: "desc" } });
console.log(JSON.stringify({ email: u?.email, businessId: b?.id, businessName: b?.name }));
await db.$disconnect();

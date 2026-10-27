import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const users = await prisma.user.findMany({
  select: { email: true, memberships: { select: { role: true, business: { select: { name: true } } } } },
  orderBy: { email: "asc" },
});
for (const u of users) console.log(u.email, "->", u.memberships.map(m => `${m.business?.name}:${m.role}`).join(", ") || "NO BUSINESS");
const b = await prisma.business.findMany({ select: { name: true } });
console.log("businesses:", b.length);
await prisma.$disconnect();

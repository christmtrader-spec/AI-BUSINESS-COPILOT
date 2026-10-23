import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
const db = new PrismaClient();
const email = "r65-qa-operator@t.dev";
const pw = "R65Qa!x2026";
const prev = await db.user.findUnique({ where: { email } });
if (prev) { await db.platformOperator.deleteMany({ where: { userId: prev.id } }); await db.user.delete({ where: { id: prev.id } }); }
const user = await db.user.create({ data: { email, name: "R65 QA Operator", passwordHash: await bcrypt.hash(pw, 10), emailVerifiedAt: new Date() } });
await db.platformOperator.create({ data: { userId: user.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
console.log("QA operator ready (no MFA):", email);
await db.$disconnect();

/**
 * R113 — create (or reuse) the browser-QA READONLY operator fixture.
 * Idempotent; the sweep pattern r113-guard@test.local is already registered.
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const EMAIL = "r113-guard@test.local";
const PW = "R113-Qa-2026!";

const existing = await db.user.findUnique({ where: { email: EMAIL } });
const user =
  existing ??
  (await db.user.create({
    data: { email: EMAIL, name: "R113 Guard QA", passwordHash: hashSync(PW, 10), emailVerifiedAt: new Date() },
  }));
const op = await db.platformOperator.findUnique({ where: { userId: user.id } });
if (!op) await db.platformOperator.create({ data: { userId: user.id, role: "PLATFORM_READONLY", active: true } });
console.log(JSON.stringify({ email: EMAIL, password: PW, created: !existing }));
await db.$disconnect();

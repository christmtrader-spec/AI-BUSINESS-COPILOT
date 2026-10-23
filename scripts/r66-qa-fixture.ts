/**
 * R66 QA fixture (browser golden-path proof ONLY — not a battery):
 * creates one temporary SUPER_ADMIN operator, enrolls MFA via the REAL API
 * flow (scripts/lib/platform-mfa.ts — no direct secret writes), prints the
 * credentials + a fresh TOTP code for the agent-browser session, and
 * supports `--cleanup` for the FK-safe sweep. Zero residue guaranteed.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { enrollFixtureMfa, generateTotpCode, jarFetch, callerOf } from "./lib/platform-mfa";

const db = new PrismaClient();
const EMAIL = "r66-qa-admin@test.local";
const PASSWORD = "R66QaPass!x";
const NAME = "R66 QA Admin";

async function cleanup() {
  // FK-safe sweep: operator row first, then the user (sessions reference it).
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) { console.log("cleanup: nothing to remove"); return; }
  await db.platformOperator.deleteMany({ where: { userId: user.id } });
  await db.userSession.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  console.log("cleanup: r66 QA operator removed");
}

async function seed() {
  // Defensive pre-sweep (crashed prior run).
  await cleanup();
  const user = await db.user.create({
    data: {
      name: NAME,
      email: EMAIL,
      passwordHash: bcrypt.hashSync(PASSWORD, 10),
      emailVerifiedAt: new Date(),
      locale: "en",
    },
  });
  await db.platformOperator.create({ data: { userId: user.id, role: "PLATFORM_SUPER_ADMIN", active: true } });

  // Enroll MFA through the REAL API flow (same path an operator would take).
  const jar = new Map<string, string>();
  const caller = callerOf(jar);
  const csrf = await caller("/api/auth/csrf");
  if (csrf.status !== 200) throw new Error("csrf failed");
  const f = jarFetch(jar);
  const form = new URLSearchParams({ csrfToken: String(csrf.json.csrfToken), email: EMAIL, password: PASSWORD });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (res.status !== 200 && res.status !== 302) throw new Error(`fixture login failed: ${res.status}`);
  const { secret, recoveryCodes } = await enrollFixtureMfa(caller, PASSWORD);

  console.log(JSON.stringify({
    email: EMAIL,
    password: PASSWORD,
    secret,
    recoveryCodes,
    totp: generateTotpCode(secret, Date.now() + 30_000),
  }, null, 2));
}

const mode = process.argv[2] ?? "seed";
if (mode === "--cleanup") {
  cleanup().finally(() => db.$disconnect());
} else {
  seed().finally(() => db.$disconnect());
}

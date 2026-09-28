#!/usr/bin/env bun
/**
 * scripts/platform-operator.ts — offline operator bootstrap (Prompt 28 §61).
 *
 * THE ONLY sanctioned way to create/change platform operators besides the
 * super-admin UI. Deliberately OFFLINE:
 *  - NO default admin, NO hard-coded password, NO automatic bootstrap on
 *    startup, NO public HTTP bootstrap route (§62).
 *  - Requires an EXISTING user (never creates users), an explicit valid
 *    role and an explicit --yes confirmation.
 *  - The acting super admin in the UI re-authenticates with their password;
 *    this CLI is the bootstrapping path used before any super admin exists.
 *
 * Usage:
 *   bun scripts/platform-operator.ts list
 *   bun scripts/platform-operator.ts bootstrap --email <email> --role <PLATFORM_ROLE> [--yes]
 *   bun scripts/platform-operator.ts set-role --email <email> --role <PLATFORM_ROLE> [--yes]
 *   bun scripts/platform-operator.ts activate  --email <email> [--yes]
 *   bun scripts/platform-operator.ts deactivate --email <email> [--yes]
 *
 * Exit 0 = success · 1 = failure (reason printed; never a secret).
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = new URL("..", import.meta.url).pathname + ".env";
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}

const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const ROLES = [
  "PLATFORM_SUPER_ADMIN",
  "PLATFORM_SUPPORT",
  "PLATFORM_BILLING",
  "PLATFORM_AI_COST",
  "PLATFORM_SECURITY",
  "PLATFORM_READONLY",
] as const;

type Role = (typeof ROLES)[number];

function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} (type YES to confirm): `);
  rl.close();
  return answer.trim() === "YES";
}

async function requireUser(email: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    console.error(`✗ No user exists with email ${email}. Bootstrap NEVER creates users (§61).`);
    process.exit(1);
  }
  return user;
}

async function countActiveSuperAdmins(excludeUserId?: string): Promise<number> {
  return prisma.platformOperator.count({
    where: {
      role: "PLATFORM_SUPER_ADMIN",
      active: true,
      ...(excludeUserId ? { NOT: { userId: excludeUserId } } : {}),
    },
  });
}

async function main() {
  const command = process.argv[2];

  if (command === "list") {
    const ops = await prisma.platformOperator.findMany({
      orderBy: { createdAt: "asc" },
      include: { user: { select: { email: true, name: true } } },
    });
    if (ops.length === 0) {
      console.log("No platform operators exist.");
    } else {
      for (const o of ops) {
        console.log(
          `${o.active ? "ACTIVE   " : "INACTIVE "} ${o.role.padEnd(22)} ${o.user.email}${o.user.name ? ` (${o.user.name})` : ""} · created ${o.createdAt.toISOString()}`,
        );
      }
    }
    return;
  }

  if (command === "bootstrap" || command === "set-role") {
    const email = argValue("--email");
    const role = argValue("--role");
    if (!email || !role) {
      console.error("Usage: bootstrap|set-role --email <email> --role <PLATFORM_ROLE> [--yes]");
      process.exit(1);
    }
    if (!isRole(role)) {
      console.error(`✗ Invalid role "${role}". Valid roles: ${ROLES.join(", ")}`);
      process.exit(1);
    }
    const user = await requireUser(email);
    const existing = await prisma.platformOperator.findUnique({ where: { userId: user.id } });

    if (command === "set-role" && !existing) {
      console.error("✗ Operator record does not exist. Use `bootstrap` first.");
      process.exit(1);
    }
    if (command === "bootstrap" && existing) {
      console.error(`✗ Operator record already exists (role ${existing.role}). Use set-role/activate/deactivate.`);
      process.exit(1);
    }

    // Last-super-admin protection mirrors the API (§55).
    if (existing && existing.role === "PLATFORM_SUPER_ADMIN" && existing.active && role !== "PLATFORM_SUPER_ADMIN") {
      if ((await countActiveSuperAdmins(user.id)) === 0) {
        console.error("✗ Refused: this is the last active super admin (§55).");
        process.exit(1);
      }
    }

    const ok = await confirm(
      `Grant platform role ${role} to ${email}? This is a PRIVILEGED platform operation.`,
    );
    if (!ok) {
      console.error("✗ Aborted (no explicit confirmation).");
      process.exit(1);
    }

    const op = existing
      ? await prisma.platformOperator.update({ where: { userId: user.id }, data: { role, active: true } })
      : await prisma.platformOperator.create({ data: { userId: user.id, role, active: true } });
    console.log(`✓ ${email} is now ${op.role} (active=${op.active}).`);
    return;
  }

  if (command === "activate" || command === "deactivate") {
    const email = argValue("--email");
    if (!email) {
      console.error("Usage: activate|deactivate --email <email> [--yes]");
      process.exit(1);
    }
    const user = await requireUser(email);
    const existing = await prisma.platformOperator.findUnique({ where: { userId: user.id } });
    if (!existing) {
      console.error("✗ No operator record for this user. Use `bootstrap` first.");
      process.exit(1);
    }
    const nextActive = command === "activate";
    if (!nextActive && existing.role === "PLATFORM_SUPER_ADMIN" && existing.active) {
      if ((await countActiveSuperAdmins(user.id)) === 0) {
        console.error("✗ Refused: cannot deactivate the last active super admin (§55).");
        process.exit(1);
      }
    }
    const ok = await confirm(`${nextActive ? "Activate" : "Deactivate"} operator ${email}?`);
    if (!ok) {
      console.error("✗ Aborted (no explicit confirmation).");
      process.exit(1);
    }
    await prisma.platformOperator.update({ where: { userId: user.id }, data: { active: nextActive } });
    console.log(`✓ Operator ${email} ${nextActive ? "activated" : "deactivated"}.`);
    return;
  }

  console.log(
    [
      "Usage:",
      "  platform-operator list",
      "  platform-operator bootstrap  --email <email> --role <PLATFORM_ROLE> [--yes]",
      "  platform-operator set-role   --email <email> --role <PLATFORM_ROLE> [--yes]",
      "  platform-operator activate   --email <email> [--yes]",
      "  platform-operator deactivate --email <email> [--yes]",
      "",
      `Roles: ${ROLES.join(", ")}`,
      "",
      "Safety: requires an EXISTING user · no default admin · no automatic",
      "bootstrap · no public HTTP route · explicit confirmation required (§61/§62).",
    ].join("\n"),
  );
  process.exit(command ? 1 : 0);
}

main()
  .catch((e) => {
    console.error("✗", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

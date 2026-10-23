#!/usr/bin/env bun
/**
 * scripts/platform-setup-key.ts — R68 cold-start setup-key CLI.
 *
 * With ZERO platform operators, the R67 invite flow cannot start (its
 * minter requires an existing super admin) and the console is an honest
 * dead end. This CLI is the OFFLINE bootstrap companion:
 *
 *   bun --conditions react-server scripts/platform-setup-key.ts mint \
 *        [--email <email>] [--ttl-hours <72>]
 *   bun --conditions react-server scripts/platform-setup-key.ts status
 *
 * LAWS (§9/§60/§61 — mirrors scripts/platform-operator.ts):
 *  - NO default admin, NO hard-coded key, NO automatic bootstrap, NO HTTP
 *    minting route. The key is created HERE and shown EXACTLY ONCE.
 *  - `mint` REFUSES while any operator exists — after cold start, access is
 *    granted via the super-admin invite flow (R67) or platform-operator.ts.
 *  - Only the SHA-256 hash is stored; the raw key never enters the DB, the
 *    audit log, or any API payload (§14).
 *  - Redemption happens in the platform console's setup gate (#/platform)
 *    by an AUTHENTICATED session — optionally pinned to --email.
 *  - MFA enforcement is NOT bypassed: the new super admin still faces the
 *    fail-closed per-request MFA gate before any console data.
 *
 * Exit 0 = success · 1 = failure (reason printed; never a secret).
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";

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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function operatorCount(): Promise<number> {
  return prisma.platformOperator.count();
}

async function mint() {
  // Refuse the whole command unless the platform is still cold (§61).
  const operators = await operatorCount();
  if (operators > 0) {
    console.error(
      `✗ Refused: ${operators} platform operator(s) already exist. Setup is closed —\n  use the super-admin invite flow (Operators → Invite operator) instead.`,
    );
    process.exit(1);
  }
  const emailArg = argValue("--email")?.trim().toLowerCase() || null;
  if (emailArg) {
    const user = await prisma.user.findUnique({ where: { email: emailArg }, select: { id: true } });
    if (!user) {
      console.error(`✗ No user exists with email ${emailArg}. Setup keys NEVER create users (§61).`);
      process.exit(1);
    }
  }
  const ttlArg = argValue("--ttl-hours");
  const ttlHours = ttlArg ? Number(ttlArg) : 72;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
    console.error("✗ --ttl-hours must be between 0 and 168.");
    process.exit(1);
  }

  // The service enforces the same laws server-side (single authority §81).
  const { mintSetupKey } = await import("../src/lib/platform/setup");
  const minted = await mintSetupKey({ boundEmail: emailArg, ttlHours });

  console.log("=".repeat(64));
  console.log("PLATFORM SETUP KEY — display-once (treat it like a password)");
  console.log("=".repeat(64));
  console.log("");
  console.log(`  ${minted.key}`);
  console.log("");
  console.log(`Expires : ${minted.expiresAt.toISOString()} (${ttlHours}h)`);
  console.log(`Bound to: ${minted.boundEmail ?? "any authenticated account (single-use)"}`);
  console.log("");
  console.log("Activation steps:");
  console.log("  1. Sign in to the app with the admin account.");
  console.log("  2. Open the platform console (#/platform).");
  console.log("  3. Paste the key into 'Initial platform setup' and activate.");
  console.log("  4. Enroll MFA when prompted — SUPER_ADMIN access is fail-closed.");
  console.log("");
  console.log("This key will not be shown again. If lost, mint a new one (single-use).");
  console.log("=".repeat(64));
}

async function status() {
  const operators = await operatorCount();
  const keys = await prisma.platformSetupKey.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, boundEmail: true, expiresAt: true, usedAt: true, createdAt: true },
  });
  console.log(`Platform operators : ${operators}`);
  console.log(`Setup window       : ${operators === 0 ? "OPEN (zero-operator cold start)" : "CLOSED (self-disabled)"}`);
  if (keys.length === 0) {
    console.log("Setup keys         : none minted");
    return;
  }
  console.log("Setup keys (recent 20 — raw keys are NEVER stored):");
  for (const k of keys) {
    const state = k.usedAt ? "USED" : k.expiresAt.getTime() < Date.now() ? "EXPIRED" : "PENDING";
    console.log(
      `  ${state.padEnd(8)} ${k.createdAt.toISOString()}  expires ${k.expiresAt.toISOString()}  bound=${k.boundEmail ?? "-"}`,
    );
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "mint") return mint();
  if (command === "status") return status();
  console.log(
    [
      "Usage:",
      "  platform-setup-key mint   [--email <email>] [--ttl-hours <1-168>]  (default 72)",
      "  platform-setup-key status",
      "",
      "Safety: minting refuses while any operator exists · no default admin ·",
      "no HTTP minting route · key shown once · single-use · expiring ·",
      "redemption requires an authenticated session + MFA enrollment (§9/§61).",
      "",
      "NOTE: run with `bun --conditions react-server` (imports server-only code).",
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

#!/usr/bin/env node
// Prompt 19 §19/20/22 — environment guard for dangerous database commands.
//
// The shell command itself must be protected, not only the documentation:
//   NODE_ENV=production + db:push      → HARD FAILURE
//   NODE_ENV=production + db:reset     → HARD FAILURE
//   NODE_ENV=production + db:migrate   → HARD FAILURE (migrate dev is dev-only)
//
// Usage: node scripts/db-guard.cjs <push|reset|migrate-dev>
// Exit 0 in development/staging (the && chain proceeds), exit 1 in production.

const mode = process.argv[2];

const MESSAGES = {
  push: "db push is disabled in production. Use prisma migrate deploy.",
  reset: "Database reset is development-only and is blocked in production.",
  "migrate-dev":
    "prisma migrate dev is development-only. Use prisma migrate deploy for staging/production.",
};

if (!MESSAGES[mode]) {
  console.error(`db-guard: unknown mode "${mode ?? ""}" (expected push | reset | migrate-dev)`);
  process.exit(2);
}

if (process.env.NODE_ENV === "production") {
  console.error(`\n✖ ${MESSAGES[mode]}\n`);
  process.exit(1);
}

// Non-production: allow the underlying Prisma command to run.
process.exit(0);

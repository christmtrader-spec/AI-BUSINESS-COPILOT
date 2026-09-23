import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/app-version";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/health — minimal liveness/readiness probe (Prompt 19 §45).
 *
 * Deliberately MINIMAL: exposes application version, "database answers yes/no"
 * and a migration status SUMMARY (counts only). Never exposes the database
 * URL, schema internals, table names, secrets or error internals — the
 * endpoint must be safe to expose publicly for uptime monitoring.
 *
 * Migration status is derived from the Prisma migrations table itself so the
 * response stays truthful even if `prisma migrate status` cannot run from
 * inside the app runtime.
 */

// Cache the probe briefly so monitoring pings never pressure SQLite.
let cached: { at: number; payload: NextResponse } | null = null;
const CACHE_MS = 15_000;

export async function GET(req: Request) {
  const rl = rateLimit(`health:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: 429, retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.payload.clone();
  }

  let databaseReachable = false;
  let migrationsApplied: number | null = null;
  let migrationsPending: number | null = null;

  try {
    const rows = (await db.$queryRawUnsafe<Array<{ finished_at: number | null }>>(
      `SELECT finished_at FROM "_prisma_migrations"`,
    )) as Array<{ finished_at: number | null }>;
    databaseReachable = true;
    migrationsApplied = rows.filter((r) => r.finished_at !== null).length;
    migrationsPending = rows.filter((r) => r.finished_at === null).length;
  } catch {
    // Truthful degradation: app is up, database/migration metadata unreadable.
    databaseReachable = false;
  }

  const payload = NextResponse.json(
    {
      status: databaseReachable ? "ok" : "degraded",
      version: APP_VERSION,
      database: { reachable: databaseReachable },
      migrations: {
        applied: migrationsApplied,
        pending: migrationsPending,
      },
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );

  cached = { at: Date.now(), payload };
  return payload.clone();
}

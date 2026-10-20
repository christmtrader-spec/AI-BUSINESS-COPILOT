import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/app-version";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { getOrCreateRequestId, requestIdHeaderName } from "@/lib/observability/request-id";

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
// Prompt 29 §90 — asymmetric cache: a HEALTHY result may be reused for 15s,
// but a DEGRADED result is re-probed after only 3s so a fatal database
// failure becomes visible quickly (never a long stale "healthy"/"degraded").
let cached: { at: number; payload: NextResponse; degraded: boolean } | null = null;
const CACHE_MS = 15_000;
const DEGRADED_CACHE_MS = 3_000;

export async function GET(req: Request) {
  const rl = rateLimit(`health:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: 429, retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const effectiveTtl = cached?.degraded ? DEGRADED_CACHE_MS : CACHE_MS;
  if (cached && Date.now() - cached.at < effectiveTtl) {
    return cached.payload.clone();
  }

  let databaseReachable = false;
  let migrationsApplied: number | null = null;
  let migrationsPending: number | null = null;
  let migrationsKnown: boolean | null = null;

  try {
    const rows = (await db.$queryRawUnsafe<Array<{ finished_at: number | null }>>(
      `SELECT finished_at FROM "_prisma_migrations"`,
    )) as Array<{ finished_at: number | null }>;
    databaseReachable = true;
    migrationsKnown = true;
    migrationsApplied = rows.filter((r) => r.finished_at !== null).length;
    migrationsPending = rows.filter((r) => r.finished_at === null).length;
  } catch (error) {
    // Prompt 52 — distinguish "database is DOWN" from "database is UP but
    // provisioned via `prisma db push`" (the db-push flow creates NO
    // _prisma_migrations table — the raw probe above then throws "no such
    // table", which is NOT a degradation). Probe the business tables: if a
    // cheap SELECT answers, the database is reachable and healthy — report
    // ok with migrations "unknown" instead of a misleading "degraded".
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message) && /_prisma_migrations/i.test(message)) {
      try {
        await db.$queryRawUnsafe(`SELECT 1 FROM "User" LIMIT 1`);
        databaseReachable = true;
      } catch {
        databaseReachable = false;
      }
    } else {
      databaseReachable = false;
    }
  }

  const payload = NextResponse.json(
    {
      status: databaseReachable ? "ok" : "degraded",
      version: APP_VERSION,
      database: { reachable: databaseReachable },
      migrations: {
        applied: migrationsApplied,
        pending: migrationsPending,
        // "unknown" = db-push provisioned database (no migrations ledger).
        known: migrationsKnown,
      },
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      // Prompt 29 §25 — liveness probe carries the correlation header too.
      headers: { [requestIdHeaderName()]: getOrCreateRequestId(req) },
    },
  );

  cached = { at: Date.now(), payload, degraded: !databaseReachable };
  return payload.clone();
}

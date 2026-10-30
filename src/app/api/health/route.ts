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
    // R136 — probe the migrations LEDGER's existence through sqlite_master
    // FIRST (a plain catalog read that ANSWERS instead of throwing). The
    // previous shape queried "_prisma_migrations" directly: under the
    // documented db-push provisioning (this deployment's flow, Prompt 52)
    // that threw "no such table" on EVERY probe — the response contract was
    // already correct (Prompt 52's catch classified it), but the Prisma
    // client logged a frightening `prisma:error` stack into dev.log each
    // time (the liveness probe runs every minute — the log became a wall of
    // fake errors that buried real ones). The catalog preflight keeps the
    // EXACT response payload (db-push ⇒ migrations.known=null, "ok") while
    // the error path now fires only for a genuinely unreachable database.
    const ledger = (await db.$queryRawUnsafe<Array<{ present: number }>>(
      `SELECT COUNT(*) AS present FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'`,
    )) as Array<{ present: number }>;
    // The catalog itself answered — the database file is reachable.
    databaseReachable = true;
    if (Number(ledger[0]?.present ?? 0) > 0) {
      const rows = (await db.$queryRawUnsafe<Array<{ finished_at: number | null }>>(
        `SELECT finished_at FROM "_prisma_migrations"`,
      )) as Array<{ finished_at: number | null }>;
      migrationsKnown = true;
      migrationsApplied = rows.filter((r) => r.finished_at !== null).length;
      migrationsPending = rows.filter((r) => r.finished_at === null).length;
    }
    // present === 0 ⇒ db-push provisioned (no migrations ledger): leave
    // migrationsKnown null — the documented "unknown" (Prompt 52).
  } catch {
    // The catalog read itself failed — the database is DOWN (or locked
    // hard enough to be unreachable for probing). One confirmation probe
    // against a business table guards against a transient catalog quirk.
    try {
      await db.$queryRawUnsafe(`SELECT 1 FROM "User" LIMIT 1`);
      databaseReachable = true;
    } catch {
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

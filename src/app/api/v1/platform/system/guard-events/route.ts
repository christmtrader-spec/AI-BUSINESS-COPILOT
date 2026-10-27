/**
 * GET /api/v1/platform/system/guard-events — dev-server RSS-guard event tail
 * (R109 ops visibility).
 *
 * Surfaces the guard daemon's RECENT events (recycles, self-heal spawns,
 * high-RSS streaks, refusals) to platform operators with platform:system:read.
 * The source is the guard's own log file — this route is a READ-ONLY,
 * BOUNDED (64KB tail) view; it never writes, rotates, or deletes the log,
 * and a missing log reports `available: false` honestly (no invented state).
 *
 * R112: summary gains generationStartedAt (newest spawn-ok) and events may
 * carry effWaterMb/graceActive (post-spawn grace judgment) — passed through
 * untouched; the reader owns their semantics.
 *
 * R113: summary gains the memory story (peakRssMb, lastRecycle,
 * avgReclaimedMb, spawnBreakdown) — again reader-owned, passed through
 * untouched here.
 *
 * Dev-infra scope: the guard exists to protect the SANDBOX dev server; the
 * route reports exactly what the log contains, including its dev-only nature
 * in the payload, so operators never mistake it for production telemetry.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import {
  readGuardEvents,
  GUARD_LOG_DEFAULT,
  GUARD_EVENTS_JSONL_DEFAULT,
  mirrorPathFor,
} from "@/lib/observability/guard-events";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:system:read");

  const raw = new URL(req.url).searchParams.get("limit");
  const parsed = raw ? Number(raw) : NaN;
  const limit = Number.isFinite(parsed) ? Math.max(5, Math.min(100, Math.trunc(parsed))) : 30;

  const result = await readGuardEvents(limit);
  const logPath = process.env.GUARD_LOG_PATH || GUARD_LOG_DEFAULT;
  return platformOk({
    logPath,
    mirrorPath: mirrorPathFor(logPath) || GUARD_EVENTS_JSONL_DEFAULT,
    scope: "dev-server",
    available: result.available,
    truncated: result.truncated,
    mirror: result.mirror,
    summary: result.summary,
    events: result.events,
  });
});

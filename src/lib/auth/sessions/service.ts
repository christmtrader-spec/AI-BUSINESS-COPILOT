import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { SESSION_MAX_AGE_SECONDS, sessionLastSeenUpdateSeconds } from "@/lib/auth/config";
import { boundUserAgent, hashIp } from "@/lib/auth/security-events/service";

/**
 * UserSession registry — Prompt 30 §70-§87, §216-§219, §226-§234.
 *
 * The NextAuth JWT remains the credential transport; this registry adds
 * what a stateless JWT can never provide: per-device revocation, a device
 * list, and last-seen state. sessionVersion (unchanged, §82) stays the
 * GLOBAL kill switch; sid is the PER-DEVICE switch.
 *
 * Laws:
 *  - The raw sid/JWT is NEVER stored — only SHA-256(sid) (§71/§72).
 *  - sid is 32 random bytes base64url — never derived from userId (§71).
 *  - UserSession.expiry ALWAYS equals the JWT maxAge (§84, one authority:
 *    SESSION_MAX_AGE_SECONDS).
 *  - IP stored HASHED (§75); user-agent bounded (§233); device label is a
 *    coarse, sanitized family string — NO fingerprinting (§74/§232) and NO
 *    geolocation (§235).
 *  - lastSeenAt is THROTTLED (§85/§434): at most one write per
 *    SESSION_LAST_SEEN_UPDATE_SECONDS per session — no per-request write
 *    storm on SQLite.
 *  - Registration failure at login FAILS THE LOGIN (§217): a session that
 *    cannot be individually revoked later must never be issued.
 *  - Legacy JWTs without sid keep working during the documented
 *    compatibility window (§83/§226/§228/§229): sessionVersion + user
 *    checks still apply; only the per-device registry is bypassed.
 */

/** 32 random bytes → base64url sid (cryptographically strong, §71). */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** One-way registry key. The raw sid never touches the database. */
export function hashSessionId(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}

/**
 * Coarse device label from the user-agent family (§232/§425). Deliberately
 * simple and bounded — NOT a fingerprint; safe to render (plain family
 * words only, but the UI still escapes before HTML interpolation).
 */
export function deviceLabelFromUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const value = ua.slice(0, 255);

  const browser = (() => {
    if (/Edg\//.test(value)) return "Edge";
    if (/OPR\/|Opera/.test(value)) return "Opera";
    if (/Firefox\//.test(value)) return "Firefox";
    if (/Chrome\//.test(value)) return "Chrome";
    if (/Safari\//.test(value)) return "Safari";
    return null;
  })();
  const os = (() => {
    if (/Windows NT/.test(value)) return "Windows";
    if (/Android/.test(value)) return "Android";
    if (/iPhone|iPad|iPod/.test(value)) return "iOS";
    if (/Mac OS X/.test(value)) return "macOS";
    if (/Linux/.test(value)) return "Linux";
    return null;
  })();

  if (!browser && !os) return "Unknown device";
  if (!browser) return os as string;
  if (!os) return browser;
  return `${browser} on ${os}`;
}

export type RegisterSessionInput = {
  userId: string;
  sid: string;
  ip: string | null;
  userAgent: string | null;
  createdFrom?: string;
};

/**
 * Register a freshly issued session (§73/§216). Called from NextAuth
 * authorize() on the success path. Failure propagates — the login MUST
 * fail rather than issue an untracked session (§217).
 */
export async function registerUserSession(input: RegisterSessionInput) {
  const now = new Date();
  return db.userSession.create({
    data: {
      userId: input.userId,
      sessionTokenHash: hashSessionId(input.sid),
      expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
      userAgent: boundUserAgent(input.userAgent),
      deviceLabel: deviceLabelFromUserAgent(input.userAgent),
      ipHash: hashIp(input.ip),
      createdFrom: input.createdFrom === "assertion" ? "assertion" : "login",
      lastSeenAt: now,
    },
    select: { id: true },
  });
}

export type SessionRegistryCheck =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "NOT_FOUND" | "REVOKED" | "EXPIRED" };

/**
 * Registry validation for a sid-bearing session (§81): exists, belongs to
 * the caller, not revoked, not expired. Used by BOTH freshness gates
 * (assertFreshSession + getAuthContext) so there is exactly ONE validation
 * path (§81). Also performs the THROTTLED last-seen write (§85).
 */
export async function checkSessionRegistry(
  sid: string,
  userId: string,
): Promise<SessionRegistryCheck> {
  const row = await db.userSession.findUnique({
    where: { sessionTokenHash: hashSessionId(sid) },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      expiresAt: true,
      lastSeenAt: true,
    },
  });
  if (!row || row.userId !== userId) return { ok: false, reason: "NOT_FOUND" };
  const now = new Date();
  if (row.revokedAt) return { ok: false, reason: "REVOKED" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "EXPIRED" };

  // Throttled last-seen (§85/§434): bounded write amplification. Failures
  // are non-fatal — a missed heartbeat never invalidates a live session.
  const throttleMs = sessionLastSeenUpdateSeconds() * 1000;
  if (now.getTime() - row.lastSeenAt.getTime() > throttleMs) {
    try {
      await db.userSession.update({
        where: { id: row.id },
        data: { lastSeenAt: now },
        select: { id: true },
      });
    } catch {
      // non-fatal
    }
  }
  return { ok: true, sessionId: row.id };
}

/** Revoke one session by its registry id — owner-checked by the caller. */
export async function revokeUserSession(sessionRowId: string): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionRowId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every session EXCEPT the given one (§80/§247 — "sign out all
 * other sessions": the CURRENT session survives). Pass `exceptSessionRowId`
 * from the revoke-all route; omit it to revoke genuinely everything
 * (password change/reset/administrative flows, §219/§361).
 * Idempotent: updateMany on revokedAt null only.
 */
export async function revokeAllUserSessions(
  userId: string,
  opts: { exceptSessionRowId?: string } = {},
): Promise<number> {
  const result = await db.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts.exceptSessionRowId ? { id: { not: opts.exceptSessionRowId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** UserSessionDTO (§122) — explicit, secret-free projection. */
export type UserSessionDTO = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
  revoked: boolean;
};

export function toSessionDTO(
  row: {
    id: string;
    deviceLabel: string | null;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  },
  currentRegistryId: string | null,
): UserSessionDTO {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    isCurrent: currentRegistryId !== null && row.id === currentRegistryId,
    revoked: row.revokedAt !== null,
  };
}

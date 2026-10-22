/**
 * Platform security anomalies — failed-login BURST detection (R64).
 *
 * A pure derivation over the durable SecurityEvent ledger — no new writes,
 * no new event vocabulary (§423). Both the Security Center SUMMARY (counts
 * only — the no-identities law holds) and the dedicated anomalies endpoint
 * (identities that are ALREADY visible in the events feed under the SAME
 * permission) read from here.
 *
 * Laws:
 *  - Window and threshold are SERVER constants — never client-tuned.
 *  - Bounded: at most BURST_MAX_GROUPS per axis is inspected, so the
 *    endpoint can never become a scanning oracle over arbitrary history.
 *  - Data minimization (§90): IPs surface only as the SAME 12-hex prefix
 *    the feed shows; emails appear only because the feed itself shows them.
 */
import { db } from "@/lib/db";
import { SECURITY_EVENTS } from "@/lib/auth/security-events/service";

export const BURST_WINDOW_MINUTES = 60;
export const BURST_THRESHOLD = 5;
export const BURST_MAX_GROUPS = 200;

export type BurstBucket<K> = { key: K; count: number; lastAt: string };

export type SecurityBursts = {
  generatedAt: string;
  windowMinutes: number;
  threshold: number;
  emailBursts: Array<BurstBucket<string>>;
  ipBursts: Array<BurstBucket<string>>;
  totalBursts: number;
};

/**
 * Compute failed-login bursts over the sliding window, on two axes:
 *  - emailBursts: one identity hammering credentials (targeted attack);
 *  - ipBursts: one source address hitting many accounts (credential
 *    stuffing / spray). ipHash groups are full-hash keyed server-side but
 *    only the 12-hex prefix ever leaves the process.
 */
export async function computeFailedLoginBursts(): Promise<SecurityBursts> {
  const generatedAt = new Date();
  const from = new Date(generatedAt.getTime() - BURST_WINDOW_MINUTES * 60_000);
  const burstWhere = {
    eventType: SECURITY_EVENTS.loginFailed,
    createdAt: { gte: from },
  };

  const [userGroups, ipGroups] = await Promise.all([
    db.securityEvent.groupBy({
      by: ["userId"],
      where: { ...burstWhere, userId: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { userId: "desc" } },
      take: BURST_MAX_GROUPS,
    }),
    db.securityEvent.groupBy({
      by: ["ipHash"],
      where: { ...burstWhere, ipHash: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { ipHash: "desc" } },
      take: BURST_MAX_GROUPS,
    }),
  ]);

  const overThreshold = <K>(rows: Array<{ key: K; count: number; lastAt: string }>) =>
    rows.filter((r) => r.count >= BURST_THRESHOLD);

  const userBuckets = userGroups
    .map((g) => ({ key: g.userId as string, count: g._count._all, lastAt: g._max.createdAt ?? generatedAt }))
    .filter((b) => b.count >= BURST_THRESHOLD);

  // Emails for the offending buckets ONLY (bounded by bucket count, not by
  // the user table) — same visibility the events feed already grants.
  const emailMap = new Map<string, string>();
  if (userBuckets.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: userBuckets.map((b) => b.key) } },
      select: { id: true, email: true },
    });
    for (const u of users) emailMap.set(u.id, u.email);
  }

  const emailBursts = overThreshold(
    userBuckets.map((b) => ({
      key: emailMap.get(b.key) ?? "[deleted-user]",
      count: b.count,
      lastAt: b.lastAt.toISOString(),
    })),
  ).sort((a, b) => b.count - a.count);

  const ipBursts = overThreshold(
    ipGroups
      .map((g) => ({
        key: (g.ipHash as string).slice(0, 12),
        count: g._count._all,
        lastAt: g._max.createdAt ?? generatedAt,
      }))
      .map((b) => ({ key: b.key, count: b.count, lastAt: b.lastAt.toISOString() })),
  ).sort((a, b) => b.count - a.count);

  return {
    generatedAt: generatedAt.toISOString(),
    windowMinutes: BURST_WINDOW_MINUTES,
    threshold: BURST_THRESHOLD,
    emailBursts,
    ipBursts,
    totalBursts: emailBursts.length + ipBursts.length,
  };
}

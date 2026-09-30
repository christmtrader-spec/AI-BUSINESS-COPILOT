import "server-only";
import { db } from "@/lib/db";
import {
  notificationCleanupBatchSize,
  notificationRetentionDays,
  notificationSecurityRetentionDays,
} from "./config";

/**
 * Operational notification cleanup — Prompt 32 §58/§59/§125/§126/§212/§425.
 *
 * THIS IS OPERATIONAL DATA RETENTION — it is NOT a legal retention policy
 * and never claims to be one (§59/§125). UTC comparisons only (§426/§427).
 *
 * Policy:
 *  - NON-security notifications: deleted when OLDER than the operational
 *    retention AND already inactive (read, archived or expired) — unread
 *    recent items are never silently destroyed.
 *  - SECURITY notifications: kept for the LONGER security retention
 *    (§127) — critical security history is not pruned aggressively.
 *  - Deliveries cascade with their notification (documented in
 *    docs/security/notification-security.md — delivery history shares the
 *    notification's lifetime in this implementation).
 *  - All deletes run in bounded batches (§425).
 */

export type PruneSummary = {
  mode: "dry-run" | "apply";
  eligibleNonSecurity: number;
  eligibleSecurity: number;
  deleted: number;
};

export async function pruneExpiredNotifications(apply: boolean): Promise<PruneSummary> {
  const now = new Date();
  const operationalCutoff = new Date(now.getTime() - notificationRetentionDays() * 86_400_000);
  const securityCutoff = new Date(now.getTime() - notificationSecurityRetentionDays() * 86_400_000);
  const batchSize = notificationCleanupBatchSize();

  const eligibleNonSecurity = await db.notification.count({
    where: {
      category: { not: "SECURITY" },
      createdAt: { lt: operationalCutoff },
      OR: [
        { readAt: { not: null } },
        { archivedAt: { not: null } },
        { expiresAt: { lt: now } },
      ],
    },
  });
  const eligibleSecurity = await db.notification.count({
    where: {
      category: "SECURITY",
      createdAt: { lt: securityCutoff },
      OR: [{ readAt: { not: null } }, { archivedAt: { not: null } }],
    },
  });

  if (!apply) {
    return { mode: "dry-run", eligibleNonSecurity, eligibleSecurity, deleted: 0 };
  }

  let deleted = 0;
  // Bounded batched delete — never one unbounded statement (§425).
  for (let round = 0; round < 200; round += 1) {
    const batch = await db.notification.findMany({
      where: {
        OR: [
          {
            category: { not: "SECURITY" },
            createdAt: { lt: operationalCutoff },
            OR: [
              { readAt: { not: null } },
              { archivedAt: { not: null } },
              { expiresAt: { lt: now } },
            ],
          },
          {
            category: "SECURITY",
            createdAt: { lt: securityCutoff },
            OR: [{ readAt: { not: null } }, { archivedAt: { not: null } }],
          },
        ],
      },
      select: { id: true },
      take: batchSize,
      orderBy: { createdAt: "asc" },
    });
    if (batch.length === 0) break;
    const result = await db.notification.deleteMany({
      where: { id: { in: batch.map((row) => row.id) } },
    });
    deleted += result.count;
    if (batch.length < batchSize) break;
  }

  return { mode: "apply", eligibleNonSecurity, eligibleSecurity, deleted };
}

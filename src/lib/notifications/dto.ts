import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { NOTIFICATION_CATALOG, isNotificationType, type NotificationType } from "./catalog";
import { notificationMaxPageSize } from "./config";
import { renderNotificationForUser } from "./templates";
import { isNotificationCategory, isNotificationPriority } from "./types";
import type { NotificationCategory, NotificationPriority } from "./types";

/**
 * Notification queries + DTO — Prompt 32 §53/§54/§106/§183/§189/§190/§334.
 *
 * DTO LAW (§189): id, type, category, priority, severity, localized title/
 * body, read state, timestamps, server-generated action, and a BUSINESS
 * CONTEXT SUMMARY only. Internal data (dataJson, delivery rows, keys) is
 * never exposed — the client renders plain strings, never HTML (§152).
 */

const actionRoutePathMap: Record<string, string> = {
  security: "#/settings/security",
  billing: "#/settings/billing",
  data: "#/data",
  usage: "#/settings/billing",
  notifications: "#/notifications",
  dashboard: "#/dashboard",
  // Prompt 37 (§23/§88) — the only CRM task CTA: opens the Tasks workspace.
  crmTasks: "#/crm?tab=tasks",
};

export type NotificationDTO = {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  priority: NotificationPriority;
  severity: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
  action: { labelKey: string; route: string } | null;
  businessName: string | null;
};

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(notificationMaxPageSize()).default(20),
  category: z.string().optional(),
  unread: z.enum(["true", "false"]).optional(),
  priority: z.string().optional(),
  businessId: z.string().max(64).optional(),
});

export type ListNotificationsResult = {
  items: NotificationDTO[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * List the CURRENT user's ACTIVE notifications (§53/§57): not archived,
 * not expired, newest first with a stable secondary key (§334). Only the
 * allowlisted filters are honored (§53); everything else is ignored.
 */
export async function listNotifications(
  userId: string,
  query: URLSearchParams,
  locale: "en" | "fa",
  memberships: { businessId: string }[],
): Promise<ListNotificationsResult> {
  const parsed = listQuerySchema.safeParse(Object.fromEntries(query.entries()));
  const filters = parsed.success ? parsed.data : listQuerySchema.parse({});

  const memberIds = memberships.map((m) => m.businessId);
  const where = {
    userId,
    archivedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    ...(filters.category && isNotificationCategory(filters.category)
      ? { category: filters.category satisfies NotificationCategory }
      : {}),
    ...(filters.unread === "true" ? { readAt: null } : {}),
    ...(filters.priority && isNotificationPriority(filters.priority)
      ? { priority: filters.priority satisfies NotificationPriority }
      : {}),
    // §197/§198 — a business filter is honored ONLY for businesses the user
    // currently belongs to; membership-at-read-time is the authority.
    ...(filters.businessId && memberIds.includes(filters.businessId)
      ? { businessId: filters.businessId }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      select: {
        id: true,
        type: true,
        category: true,
        priority: true,
        severity: true,
        titleKey: true,
        bodyKey: true,
        dataJson: true,
        actionRoute: true,
        readAt: true,
        createdAt: true,
        businessId: true,
      },
    }),
    db.notification.count({ where }),
  ]);

  // §196 — business names for business-specific notifications (summary only).
  const businessIds = [...new Set(rows.map((r) => r.businessId).filter((id): id is string => Boolean(id)))];
  const businesses = businessIds.length
    ? await db.business.findMany({
        where: { id: { in: businessIds }, members: { some: { userId } } },
        select: { id: true, name: true },
      })
    : [];
  const businessNameById = new Map(businesses.map((b) => [b.id, b.name]));

  const items = rows.map((row) => toDTO(row, businessNameById, locale));
  return { items, page: filters.page, pageSize: filters.pageSize, total };
}

type RowShape = {
  id: string;
  type: string;
  category: string;
  priority: string;
  severity: string;
  titleKey: string;
  bodyKey: string;
  dataJson: string | null;
  actionRoute: string | null;
  readAt: Date | null;
  createdAt: Date;
  businessId: string | null;
};

function toDTO(
  row: RowShape,
  businessNameById: Map<string, string>,
  locale: "en" | "fa",
): NotificationDTO {
  const type = isNotificationType(row.type) ? row.type : null;
  let data: Record<string, unknown> | null = null;
  if (row.dataJson) {
    try {
      data = JSON.parse(row.dataJson) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  const rendered =
    type !== null
      ? renderNotificationForUser(type, data, locale)
      : { title: row.titleKey, body: row.bodyKey };
  const actionRoute =
    row.actionRoute && row.actionRoute in actionRoutePathMap ? row.actionRoute : null;
  return {
    id: row.id,
    type: type ?? "SYSTEM_ANNOUNCEMENT",
    category: (isNotificationCategory(row.category) ? row.category : "SYSTEM") as NotificationCategory,
    priority: (isNotificationPriority(row.priority) ? row.priority : "NORMAL") as NotificationPriority,
    severity: row.severity,
    title: rendered.title,
    body: rendered.body,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    action:
      type !== null && actionRoute
        ? {
            labelKey: NOTIFICATION_CATALOG[type].titleKey,
            route: actionRoutePathMap[actionRoute],
          }
        : null,
    businessName: row.businessId ? (businessNameById.get(row.businessId) ?? null) : null,
  };
}

/** Bounded unread count (§52/§107/§218 — indexed userId+readAt filter). */
export async function unreadNotificationCount(userId: string): Promise<number> {
  return db.notification.count({
    where: {
      userId,
      readAt: null,
      archivedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
}

/**
 * Load ONE notification owned by the CURRENT user (§183/§184) — ownership
 * is part of the WHERE; another user's id simply does not exist here
 * (404-safe, no existence leak).
 */
export async function findOwnedNotification(userId: string, notificationId: string) {
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(notificationId)) return null;
  return db.notification.findFirst({
    where: { id: notificationId, userId },
    select: { id: true, readAt: true, archivedAt: true },
  });
}

/** Mark read — idempotent, cheap, bounded to one owned row (§245). */
export async function markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
  const owned = await findOwnedNotification(userId, notificationId);
  if (!owned) return false;
  if (owned.readAt) return true;
  await db.notification.update({
    where: { id: owned.id },
    data: { readAt: new Date() },
  });
  return true;
}

/** Mark unread where useful (§50). */
export async function markNotificationUnread(userId: string, notificationId: string): Promise<boolean> {
  const owned = await findOwnedNotification(userId, notificationId);
  if (!owned) return false;
  if (!owned.readAt) return true;
  await db.notification.update({
    where: { id: owned.id },
    data: { readAt: null },
  });
  return true;
}

/**
 * Archive — a UX state, never a deletion (§56/§118/§370/§371). Security
 * history is preserved for its documented retention period.
 */
export async function archiveNotification(userId: string, notificationId: string): Promise<boolean> {
  const owned = await findOwnedNotification(userId, notificationId);
  if (!owned) return false;
  if (owned.archivedAt) return true;
  await db.notification.update({
    where: { id: owned.id },
    data: { archivedAt: new Date() },
  });
  return true;
}

/**
 * Mark ALL read in ONE bounded statement (§55/§219) — no row-by-row loop;
  * other users are never touched (§301).
 */
export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await db.notification.updateMany({
    where: { userId, readAt: null, archivedAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

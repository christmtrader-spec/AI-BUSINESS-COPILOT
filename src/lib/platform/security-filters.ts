/**
 * Shared allowlisted filter parsing for the platform Security Center feed
 * and its CSV export (R64). ONE parser — two consumers (§81 single-path
 * law): a request string can never become a Prisma field name (§71), and
 * unknown values are 422'd, never silently dropped.
 */
import type { Prisma } from "@prisma/client";
import { platformError } from "@/lib/platform/auth";
import { queryDate, queryFilter } from "@/lib/platform/http";
import { SECURITY_EVENTS } from "@/lib/auth/security-events/service";

/** Fixed vocabulary — the ONLY filterable event types (§71/§423). */
export const SECURITY_EVENT_TYPES: string[] = Object.values(SECURITY_EVENTS);
const eventTypeSet = new Set(SECURITY_EVENT_TYPES);

export type SecurityEventFilters = {
  eventType: string | undefined;
  success: boolean | undefined;
  userId: string | undefined;
  email: string | undefined;
  createdFrom: Date | undefined;
  createdTo: Date | undefined;
};

/** Parse + validate the event filters from a URL — throws 422 on garbage. */
export function parseSecurityEventFilters(sp: URLSearchParams): SecurityEventFilters {
  const rawEventType = queryFilter(sp, "eventType", 64);
  let eventType: string | undefined;
  if (rawEventType) {
    if (!eventTypeSet.has(rawEventType)) {
      throw platformError(422, "PLATFORM_INVALID_OPERATION", "Unknown event type filter.", {
        eventType: rawEventType,
      });
    }
    eventType = rawEventType;
  }

  const successRaw = queryFilter(sp, "success", 8);
  let success: boolean | undefined;
  if (successRaw === "true") success = true;
  else if (successRaw === "false") success = false;
  else if (successRaw !== undefined) {
    throw platformError(422, "PLATFORM_INVALID_OPERATION", "The success filter must be true or false.");
  }

  return {
    eventType,
    success,
    userId: queryFilter(sp, "userId", 64),
    email: queryFilter(sp, "email", 200),
    createdFrom: queryDate(sp, "createdFrom"),
    createdTo: queryDate(sp, "createdTo", true),
  };
}

/** Build the bounded Prisma WHERE from parsed filters (single source). */
export function securityEventWhere(f: SecurityEventFilters): Prisma.SecurityEventWhereInput {
  return {
    ...(f.eventType ? { eventType: f.eventType } : {}),
    ...(f.success !== undefined ? { success: f.success } : {}),
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.email ? { user: { is: { email: { contains: f.email.toLowerCase() } } } } : {}),
    ...(f.createdFrom || f.createdTo
      ? {
          createdAt: {
            ...(f.createdFrom ? { gte: f.createdFrom } : {}),
            ...(f.createdTo ? { lte: f.createdTo } : {}),
          },
        }
      : {}),
  };
}

/** Stable, bounded description of the active filters for audit rows. */
export function describeEventFilters(f: SecurityEventFilters): Record<string, string | boolean | undefined> {
  return {
    eventType: f.eventType,
    success: f.success,
    userId: f.userId,
    email: f.email,
    createdFrom: f.createdFrom?.toISOString(),
    createdTo: f.createdTo?.toISOString(),
  };
}

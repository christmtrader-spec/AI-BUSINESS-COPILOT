/**
 * GET /api/v1/billing/events — the active business's subscription history
 * (§20/§62). Tenant-scoped by the membership-verified context; another
 * business's events are unresolvable by construction (§56).
 * Permission: settings:read (viewing history is read-only; MUTATING
 * subscription state requires OWNER/ADMIN, §100).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { listSubscriptionEvents } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const url = new URL(req.url);
  const page = Number(url.searchParams.get("page") ?? "1") || 1;
  const pageSize = Number(url.searchParams.get("pageSize") ?? "20") || 20;

  const result = await listSubscriptionEvents(ctx.businessId, { page, pageSize });
  return ok(result);
});

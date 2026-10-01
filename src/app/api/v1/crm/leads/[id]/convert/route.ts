/**
 * POST /api/v1/crm/leads/[id]/convert — atomic lead conversion (§23–§26).
 *
 * EXISTING_CUSTOMER (customerId required) or CREATE_CUSTOMER (fields from
 * the dialog, pre-filled from the lead). Optional opportunityTitle creates
 * ONE opportunity linked to the resulting customer inside the SAME
 * transaction. CUSTOMERS_MAX is enforced inside the transaction (§75).
 * No sale, no payment, no revenue effect (§1/§33).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { convertLead, getLeadDetail, leadConvertSchema } from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, leadConvertSchema);
  const result = await convertLead(ctx.businessId, ctx.userId, id, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ ...(await getLeadDetail(ctx.businessId, id)), result });
});

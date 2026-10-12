/**
 * Prompt 47 — GET  /api/v1/sales-quotations  (bounded list   — data:read)
 *             POST /api/v1/sales-quotations  (create draft   — data:write)
 *
 * Create derives tenant scope, the currency snapshot, the customer
 * snapshot and creator from the SERVER (never client input §2.4/§10/§15).
 * The list is DB-paginated (pageSize ≤ 100), never findMany+slice; date
 * filters interpret from/to in the AUTHENTICATED business timezone.
 * Creating a quotation NEVER mutates stock or finance (§1).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createSalesQuotation, listSalesQuotations } from "@/lib/sales-quotations/service";
import { salesQuotationCreateSchema, salesQuotationListQuerySchema } from "@/lib/sales-quotations/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, salesQuotationCreateSchema);
  const row = await createSalesQuotation({
    businessId: ctx.businessId, // server-derived tenant scope
    userId: ctx.userId,
    timezone: ctx.business.timezone || "UTC", // AUTH ctx only, never the client
    customerId: input.customerId, // optional; validated + snapshotted server-side
    reference: input.reference, // undefined → server generation (§10)
    quotationDate: input.quotationDate,
    validUntilDate: input.validUntilDate,
    expectedDeliveryDate: input.expectedDeliveryDate,
    discountMinor: input.discountMinor,
    customerNotes: input.customerNotes ?? null,
    internalNotes: input.internalNotes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  let parsed;
  try {
    parsed = salesQuotationListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid sales quotation list query.");
  }
  const result = await listSalesQuotations({
    businessId: ctx.businessId,
    q: parsed.q,
    status: parsed.status,
    customerId: parsed.customerId,
    from: parsed.from,
    to: parsed.to,
    timezone: ctx.business.timezone || "UTC", // AUTH ctx only, never the client
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25,
  });
  return ok(result);
});

/**
 * GET    /api/v1/expenses/[id] — expense detail + payments (data:read).
 * PATCH  /api/v1/expenses/[id] — update (data:write, audited). Amount may
 *        never drop below what has already been paid (kept consistent with payments).
 * DELETE /api/v1/expenses/[id] — soft delete (data:write). Blocked while
 *        payments exist.
 *
 * Prompt 34 (§18/§20/§21/§85): tenant-scoped GET, soft-delete filter,
 * explicit DTO with supplier name only (no supplier object), bounded
 * payments list (≤20), integer minor units.
 * Prompt 48 (§12): an Expense linked to a POSTED SupplierBill is the
 * document-backed payable — generic deletion and generic edits that would
 * break reconciliation with its posted bill (amount, supplier, category,
 * spentAt, dueDate, document reference) are blocked with the stable
 * SUPPLIER_BILL_LINKED_EXPENSE_IMMUTABLE error. Free-text note edits stay
 * allowed; Payment-controlled paidMinor/status updates are untouched.
 */
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { expenseUpdateSchema } from "@/lib/schemas";
import { statusOf } from "@/lib/money";
import { mapExpenseDetail } from "@/lib/entities";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Bounded payments list (§18/§85). */
const PAYMENTS_TAKE = 20;

/**
 * Prompt 48 §12 — load the bill link for a payable. A bill carries
 * expenseId ONLY from posting onward (DRAFT/CANCELLED bills have none),
 * so any linked bill found here is a POSTED document-backed payable.
 */
async function loadLinkedPostedBill(businessId: string, expenseId: string) {
  return db.supplierBill.findFirst({
    where: { businessId, expenseId },
    select: { id: true, reference: true, status: true, totalMinor: true },
  });
}

/** The ONE stable block for reconciliation-breaking edits/deletes (§12). */
function throwLinkedExpenseImmutable(): never {
  throw new ApiError(
    422,
    "SUPPLIER_BILL_LINKED_EXPENSE_IMMUTABLE",
    "This payable is linked to a posted supplier bill and cannot be edited or deleted here. Its amount, supplier, category and dates must stay reconciled with the bill document.",
  );
}

async function loadExpense(businessId: string, id: string) {
  const expense = await db.expense.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!expense) throw new ApiError(404, "NOT_FOUND", "Expense not found.");
  return expense;
}

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §20 — foreign/deleted record → 404 (same path as unknown id).
  const expense = await db.expense.findFirst({
    where: { id, businessId: ctx.businessId, deletedAt: null },
    select: {
      id: true,
      category: true,
      amountMinor: true,
      paidMinor: true,
      status: true,
      spentAt: true,
      dueDate: true,
      reference: true,
      note: true,
      supplierId: true,
      supplier: { select: { name: true } },
      createdAt: true,
    },
  });
  if (!expense) throw new ApiError(404, "NOT_FOUND", "Expense not found.");

  // §85 — bounded, deterministic, explicit select (§86).
  const payments = await db.payment.findMany({
    where: { businessId: ctx.businessId, expenseId: id },
    orderBy: [{ paidAt: "desc" }, { id: "desc" }],
    take: PAYMENTS_TAKE,
    select: {
      id: true,
      amountMinor: true,
      method: true,
      paidAt: true,
      note: true,
      actor: { select: { name: true, email: true } },
    },
  });

  return ok(
    mapExpenseDetail(
      {
        id: expense.id,
        category: expense.category,
        amountMinor: expense.amountMinor,
        paidMinor: expense.paidMinor,
        status: expense.status,
        spentAt: expense.spentAt,
        dueDate: expense.dueDate,
        reference: expense.reference,
        note: expense.note,
        supplierId: expense.supplierId,
        supplierName: expense.supplier?.name ?? null,
        createdAt: expense.createdAt,
      },
      payments.map((p) => ({
        id: p.id,
        amountMinor: p.amountMinor,
        method: p.method,
        paidAt: p.paidAt,
        note: p.note,
        actorName: p.actor?.name ?? p.actor?.email ?? null,
      })),
    ),
  );
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadExpense(ctx.businessId, id);
  const input = await parseBody(req, expenseUpdateSchema);

  // Prompt 48 §12 — a bill-linked payable cannot be edited in ways that
  // break reconciliation with its posted bill. `note` stays editable.
  const linkedBill = await loadLinkedPostedBill(ctx.businessId, before.id);
  if (linkedBill && linkedBill.status === "POSTED") {
    const touchesReconciliation =
      input.amountMinor !== undefined ||
      input.supplierId !== undefined ||
      input.category !== undefined ||
      input.spentAt !== undefined ||
      input.dueDate !== undefined ||
      input.reference !== undefined;
    if (touchesReconciliation) throwLinkedExpenseImmutable();
  }

  if (
    input.amountMinor !== undefined &&
    input.amountMinor < before.paidMinor
  ) {
    throw new ApiError(
      422,
      "AMOUNT_BELOW_PAID",
      `Amount cannot be lower than what has already been paid (${before.paidMinor} minor units).`,
    );
  }
  if (input.supplierId) {
    const supplier = await db.supplier.findFirst({
      where: { id: input.supplierId, businessId: ctx.businessId, deletedAt: null },
    });
    if (!supplier) {
      throw new ApiError(422, "INVALID_SUPPLIER", "Supplier not found in this business.");
    }
  }

  const updated = await db.$transaction(async (tx) => {
    // Build the patch explicitly — only fields the client actually sent.
    // (undefined = untouched; null = clear the FK. Spreading `input` directly
    // trips Prisma's UpdateInput XOR types.)
    const patch: Prisma.ExpenseUncheckedUpdateInput = {};
    if (input.supplierId !== undefined) patch.supplierId = input.supplierId;
    if (input.category !== undefined) patch.category = input.category;
    if (input.amountMinor !== undefined) {
      patch.amountMinor = input.amountMinor;
      patch.status = statusOf(input.amountMinor, before.paidMinor);
    }
    // spentAt is NOT NULL in the schema — a null in the payload is ignored
    // (the zod schema funnels absent → null; only a real date is written).
    if (input.spentAt) patch.spentAt = input.spentAt;
    // dueDate/reference are three-state: undefined = untouched, null = clear.
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.reference !== undefined) patch.reference = input.reference;
    if (input.note !== undefined) patch.note = input.note;
    const e = await tx.expense.update({
      where: { id: before.id },
      data: patch,
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "expense.update",
        entityType: "Expense",
        entityId: e.id,
        before,
        after: e,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return e;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadExpense(ctx.businessId, id);
  const paymentCount = await db.payment.count({ where: { expenseId: before.id, businessId: ctx.businessId } });
  if (paymentCount > 0 || before.paidMinor !== 0) {
    throw new ApiError(
      422,
      "EXPENSE_HAS_PAYMENTS",
      "This expense has payments recorded. Delete its payments first to keep the money history consistent.",
    );
  }

  // Prompt 48 §12 — never delete the payable behind a posted supplier bill
  // (a posted bill must not lose its linked Expense).
  const linkedBill = await loadLinkedPostedBill(ctx.businessId, before.id);
  if (linkedBill && linkedBill.status === "POSTED") throwLinkedExpenseImmutable();

  await db.$transaction(async (tx) => {
    await tx.expense.update({ where: { id: before.id }, data: { deletedAt: new Date() } });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "expense.delete",
        entityType: "Expense",
        entityId: before.id,
        before,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ deleted: true });
});

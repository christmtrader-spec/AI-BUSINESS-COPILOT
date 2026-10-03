/**
 * POST /api/v1/businesses/[id]/import — restore records from a backup file.
 * The other half of the Phase 06 backup story (export → import round-trip).
 *
 * Modes (query param `mode`):
 * - `dry_run` — validate the file, diff against current DB state and return
 *   a per-entity report + conflicts. No writes.
 * - `merge`   — create the plan computed by the same diff inside ONE
 *   transaction. Existing records are never modified or deleted.
 *
 * ID handling (query param `ids`, default `keep`):
 * - `keep` — original ids preserved. Best for restoring into the SAME
 *   business after data loss (deleted rows freed their ids). An id that is
 *   still occupied ANYWHERE (this business → "existing"; another business →
 *   ID_OCCUPIED conflict) is skipped — never a crash.
 * - `new` — every created record receives a fresh id; sale invoice numbers
 *   are re-sequenced after the business's current maximum; all references
 *   (customer/product/supplier/sale/expense) are remapped. Best for copying
 *   records from another business.
 *
 * Law notes:
 * - OWNER-only by design: import mutates the financial dataset as a whole
 *   (strategic/destructive operation) — even ADMINs are excluded.
 * - Tenant: getAuthContext + URL-id match (A01/A02).
 * - A08: money arrives as integer minor units; zod rejects floats. Sale line
 *   totals are re-verified with integer math (qty × unitPriceMinor).
 * - members + auditTrail are never imported. Business configuration
 *   (currency etc.) is never changed; a currency mismatch produces a loud
 *   warning in the report.
 * - Rate limited 4/5min/user; audited "data.import".
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  backupV1Schema,
  emptyEntityReport,
  type ImportConflict,
  type ImportEntity,
  type ImportReport,
} from "@/lib/backup-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteParams = { params: Promise<{ id: string }> };

/** Fresh id for `ids=new` mode (globally unique, no deps). */
function freshId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 25);
}

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "settings:manage"); // still enforced — then tightened:
  if (ctx.role !== "OWNER") {
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      "Only the business owner can restore records from a backup.",
      { requiredRole: "OWNER", role: ctx.role },
    );
  }

  const limit = rateLimit(`import:${ctx.userId}`, 4, 5 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Too many imports in a short time. Please wait a moment.",
      { retryAfterMs: limit.retryAfterMs },
    );
  }

  const modeParam = req.nextUrl.searchParams.get("mode") === "merge" ? "merge" : "dry_run";
  const idsParam = req.nextUrl.searchParams.get("ids") === "new" ? "new" : "keep";

  // Body IS the backup file content. Bound the parse size BEFORE reading
  // the body (audit hardening): zod caps row counts, this caps raw bytes
  // so a hostile owner cannot force a giant JSON parse into memory.
  const MAX_BACKUP_BYTES = 25 * 1024 * 1024; // 25 MB — far above any legit export
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BACKUP_BYTES) {
    throw new ApiError(413, "BACKUP_TOO_LARGE", "The backup file exceeds the 25 MB limit.");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "BAD_JSON", "The backup file is not valid JSON.");
  }

  const parsed = backupV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, "INVALID_BACKUP", "This file is not a valid AI Business Copilot backup.", {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const backup = parsed.data;

  const businessId = ctx.businessId;
  const businessMatch = backup.business.id === businessId;
  const currencyMatch = backup.business.currencyCode === ctx.business.currencyCode;

  // ---- Current DB state (tenant-scoped) ------------------------------------
  const [
    existingCustomerIds,
    existingSupplierIds,
    existingProductIds,
    existingAdjustmentIds,
    existingSaleRefs,
    existingExpenseIds,
    existingPaymentIds,
    maxSaleNumberRow,
  ] = await Promise.all([
    db.customer.findMany({ where: { businessId }, select: { id: true } }),
    db.supplier.findMany({ where: { businessId }, select: { id: true } }),
    db.product.findMany({ where: { businessId }, select: { id: true } }),
    db.inventoryAdjustment.findMany({ where: { businessId }, select: { id: true } }),
    db.sale.findMany({ where: { businessId }, select: { id: true, number: true } }),
    db.expense.findMany({ where: { businessId }, select: { id: true } }),
    db.payment.findMany({ where: { businessId }, select: { id: true } }),
    db.sale.aggregate({ where: { businessId }, _max: { number: true } }),
  ]);

  const ownCustomerIds = new Set(existingCustomerIds.map((r) => r.id));
  const ownSupplierIds = new Set(existingSupplierIds.map((r) => r.id));
  const ownProductIds = new Set(existingProductIds.map((r) => r.id));
  const ownAdjustmentIds = new Set(existingAdjustmentIds.map((r) => r.id));
  const ownSaleIds = new Set(existingSaleRefs.map((r) => r.id));
  const saleNumbers = new Map<number, string>(); // number -> sale id
  for (const s of existingSaleRefs) saleNumbers.set(s.number, s.id);
  const ownExpenseIds = new Set(existingExpenseIds.map((r) => r.id));
  const ownPaymentIds = new Set(existingPaymentIds.map((r) => r.id));

  // Global occupancy (ids are GLOBAL primary keys — a backup row whose id
  // belongs to a record of ANOTHER business can never be created as-is).
  let occupiedCustomerIds = new Set<string>();
  let occupiedSupplierIds = new Set<string>();
  let occupiedProductIds = new Set<string>();
  let occupiedAdjustmentIds = new Set<string>();
  let occupiedSaleIds = new Set<string>();
  let occupiedExpenseIds = new Set<string>();
  let occupiedPaymentIds = new Set<string>();
  if (idsParam === "keep") {
    const cIds = backup.customers.map((r) => r.id);
    const sIds = backup.suppliers.map((r) => r.id);
    const pIds = backup.products.map((r) => r.id);
    const aIds = backup.inventoryAdjustments.map((r) => r.id);
    const sSaleIds = backup.sales.map((r) => r.id);
    const eIds = backup.expenses.map((r) => r.id);
    const payIds = backup.payments.map((r) => r.id);
    const [
      gCustomers,
      gSuppliers,
      gProducts,
      gAdjustments,
      gSales,
      gExpenses,
      gPayments,
    ] = await Promise.all([
      cIds.length ? db.customer.findMany({ where: { id: { in: cIds } }, select: { id: true } }) : [],
      sIds.length ? db.supplier.findMany({ where: { id: { in: sIds } }, select: { id: true } }) : [],
      pIds.length ? db.product.findMany({ where: { id: { in: pIds } }, select: { id: true } }) : [],
      aIds.length ? db.inventoryAdjustment.findMany({ where: { id: { in: aIds } }, select: { id: true } }) : [],
      sSaleIds.length ? db.sale.findMany({ where: { id: { in: sSaleIds } }, select: { id: true } }) : [],
      eIds.length ? db.expense.findMany({ where: { id: { in: eIds } }, select: { id: true } }) : [],
      payIds.length ? db.payment.findMany({ where: { id: { in: payIds } }, select: { id: true } }) : [],
    ]);
    occupiedCustomerIds = new Set(gCustomers.map((r) => r.id));
    occupiedSupplierIds = new Set(gSuppliers.map((r) => r.id));
    occupiedProductIds = new Set(gProducts.map((r) => r.id));
    occupiedAdjustmentIds = new Set(gAdjustments.map((r) => r.id));
    occupiedSaleIds = new Set(gSales.map((r) => r.id));
    occupiedExpenseIds = new Set(gExpenses.map((r) => r.id));
    occupiedPaymentIds = new Set(gPayments.map((r) => r.id));
  }

  const conflicts: ImportConflict[] = [];
  const report: ImportReport = {
    mode: modeParam,
    businessMatch,
    businessName: backup.business.name,
    exportedAt: backup.exportedAt ?? null,
    currencyMatch,
    entities: emptyEntityReport(),
    conflicts,
    wouldCreate: 0,
    created: 0,
  };
  const ENTITY_LABEL: Record<ImportEntity, string> = {
    customers: "customer",
    suppliers: "supplier",
    products: "product",
    inventoryAdjustments: "inventory adjustment",
    sales: "sale",
    expenses: "expense",
    payments: "payment",
  };
  const conflict = (entity: ImportEntity, reason: ImportConflict["reason"], ref: string) =>
    conflicts.push({ entity, reason, ref: `${ENTITY_LABEL[entity]} ${ref}` });

  const toDate = (s: string | null | undefined) => (s ? new Date(s) : undefined);

  // In `new` mode every created row gets a fresh id; oldId -> newId map.
  const idMap = new Map<string, string>();
  // Resolve a reference: prefer the remapped id, then the target business DB.
  const resolveRef = (
    ref: string | null,
    ownSet: Set<string> | null,
    entity: ImportEntity,
    ownerRef: string,
  ): string | null => {
    if (ref === null) return null;
    const mapped = idMap.get(ref);
    if (mapped) return mapped;
    if (ownSet && ownSet.has(ref)) return ref;
    conflict(entity, "MISSING_REFERENCE", ref);
    void ownerRef;
    return null;
  };

  // ---- Plan: customers / suppliers / products ------------------------------
  type Plan<T> = { row: T; id: string }[];
  const planParty = <T extends { id: string }>(
    rows: T[],
    entity: ImportEntity,
    occupied: Set<string>,
    own: Set<string>,
  ): Plan<T> => {
    const seen = new Set<string>();
    const plan: Plan<T> = [];
    for (const r of rows) {
      if (seen.has(r.id)) {
        conflict(entity, "DUPLICATE_ID", `#${r.id}`);
        report.entities[entity].invalid++;
        continue;
      }
      seen.add(r.id);
      if (idsParam === "keep") {
        if (own.has(r.id)) {
          report.entities[entity].existing++;
          continue;
        }
        if (occupied.has(r.id)) {
          conflict(entity, "ID_OCCUPIED", `#${r.id}`);
          report.entities[entity].invalid++;
          continue;
        }
      }
      const newId = idsParam === "keep" ? r.id : freshId();
      idMap.set(r.id, newId);
      plan.push({ row: r, id: newId });
    }
    report.entities[entity].total = rows.length;
    report.entities[entity].toCreate = plan.length;
    return plan;
  };

  const planCustomers = planParty(backup.customers, "customers", occupiedCustomerIds, ownCustomerIds);
  const planSuppliers = planParty(backup.suppliers, "suppliers", occupiedSupplierIds, ownSupplierIds);
  const planProducts = planParty(backup.products, "products", occupiedProductIds, ownProductIds);

  // ---- Plan: sales (items re-verified with integer math, numbers resequenced)
  const salesSorted = [...backup.sales].sort((a, b) => a.number - b.number);
  let nextNumber = (maxSaleNumberRow._max.number ?? 0) + 1;
  const seenSaleIds = new Set<string>();
  const planSales: { row: (typeof backup.sales)[number]; id: string; number: number }[] = [];
  for (const s of salesSorted) {
    if (seenSaleIds.has(s.id)) {
      conflict("sales", "DUPLICATE_ID", `#${s.id}`);
      report.entities.sales.invalid++;
      continue;
    }
    seenSaleIds.add(s.id);
    if (idsParam === "keep") {
      if (ownSaleIds.has(s.id)) {
        report.entities.sales.existing++;
        idMap.set(s.id, s.id); // payments may reference it
        continue;
      }
      if (occupiedSaleIds.has(s.id)) {
        conflict("sales", "ID_OCCUPIED", `#${s.id}`);
        report.entities.sales.invalid++;
        continue;
      }
      const owner = saleNumbers.get(s.number);
      if (owner && owner !== s.id) {
        conflict("sales", "NUMBER_COLLISION", `#${s.number}`);
        report.entities.sales.invalid++;
        continue;
      }
    }
    let bad = false;
    for (const item of s.items) {
      if (item.qty * item.unitPriceMinor !== item.lineTotalMinor) {
        conflict("sales", "LINE_TOTAL_MISMATCH", `#${s.number}`);
        bad = true;
        break;
      }
    }
    if (bad) {
      report.entities.sales.invalid++;
      continue;
    }
    const number = idsParam === "keep" ? s.number : nextNumber++;
    const newId = idsParam === "keep" ? s.id : freshId();
    idMap.set(s.id, newId);
    planSales.push({ row: s, id: newId, number });
  }
  report.entities.sales.total = backup.sales.length;
  report.entities.sales.toCreate = planSales.length;

  // ---- Plan: expenses --------------------------------------------------------
  const planExpenses: { row: (typeof backup.expenses)[number]; id: string; supplierId: string | null }[] = [];
  {
    const seen = new Set<string>();
    for (const e of backup.expenses) {
      if (seen.has(e.id)) {
        conflict("expenses", "DUPLICATE_ID", `#${e.id}`);
        report.entities.expenses.invalid++;
        continue;
      }
      seen.add(e.id);
      if (idsParam === "keep") {
        if (ownExpenseIds.has(e.id)) {
          report.entities.expenses.existing++;
          idMap.set(e.id, e.id);
          continue;
        }
        if (occupiedExpenseIds.has(e.id)) {
          conflict("expenses", "ID_OCCUPIED", `#${e.id}`);
          report.entities.expenses.invalid++;
          continue;
        }
      }
      const supplierId = resolveRef(e.supplierId, ownSupplierIds, "expenses", `#${e.id}`);
      if (e.supplierId !== null && supplierId === null) {
        report.entities.expenses.invalid++;
        continue;
      }
      const newId = idsParam === "keep" ? e.id : freshId();
      idMap.set(e.id, newId);
      planExpenses.push({ row: e, id: newId, supplierId });
    }
    report.entities.expenses.total = backup.expenses.length;
    report.entities.expenses.toCreate = planExpenses.length;
  }

  // ---- Plan: adjustments (productId must resolve) ---------------------------
  const planAdjustments: {
    row: (typeof backup.inventoryAdjustments)[number];
    id: string;
    productId: string;
  }[] = [];
  {
    const seen = new Set<string>();
    for (const a of backup.inventoryAdjustments) {
      if (seen.has(a.id)) {
        conflict("inventoryAdjustments", "DUPLICATE_ID", `#${a.id}`);
        report.entities.inventoryAdjustments.invalid++;
        continue;
      }
      seen.add(a.id);
      if (idsParam === "keep") {
        if (ownAdjustmentIds.has(a.id)) {
          report.entities.inventoryAdjustments.existing++;
          continue;
        }
        if (occupiedAdjustmentIds.has(a.id)) {
          conflict("inventoryAdjustments", "ID_OCCUPIED", `#${a.id}`);
          report.entities.inventoryAdjustments.invalid++;
          continue;
        }
      }
      const productId = resolveRef(a.productId, ownProductIds, "inventoryAdjustments", `#${a.id}`);
      if (productId === null) {
        report.entities.inventoryAdjustments.invalid++;
        continue;
      }
      const newId = idsParam === "keep" ? a.id : freshId();
      planAdjustments.push({ row: a, id: newId, productId });
    }
    report.entities.inventoryAdjustments.total = backup.inventoryAdjustments.length;
    report.entities.inventoryAdjustments.toCreate = planAdjustments.length;
  }

  // ---- Plan: payments (exactly one ref, resolvable after import) ------------
  const planPayments: {
    row: (typeof backup.payments)[number];
    id: string;
    saleId: string | null;
    expenseId: string | null;
  }[] = [];
  {
    const seen = new Set<string>();
    for (const p of backup.payments) {
      if (seen.has(p.id)) {
        conflict("payments", "DUPLICATE_ID", `#${p.id}`);
        report.entities.payments.invalid++;
        continue;
      }
      seen.add(p.id);
      if (idsParam === "keep") {
        if (ownPaymentIds.has(p.id)) {
          report.entities.payments.existing++;
          continue;
        }
        if (occupiedPaymentIds.has(p.id)) {
          conflict("payments", "ID_OCCUPIED", `#${p.id}`);
          report.entities.payments.invalid++;
          continue;
        }
      }
      // Exactly-one-ref already enforced by the zod schema; resolve each side.
      let saleId: string | null = null;
      let expenseId: string | null = null;
      if (p.saleId !== null) {
        saleId = resolveRef(p.saleId, ownSaleIds, "payments", `#${p.id}`);
        if (saleId === null) {
          report.entities.payments.invalid++;
          continue;
        }
      } else if (p.expenseId !== null) {
        expenseId = resolveRef(p.expenseId, ownExpenseIds, "payments", `#${p.id}`);
        if (expenseId === null) {
          report.entities.payments.invalid++;
          continue;
        }
      }
      const newId = idsParam === "keep" ? p.id : freshId();
      planPayments.push({ row: p, id: newId, saleId, expenseId });
    }
    report.entities.payments.total = backup.payments.length;
    report.entities.payments.toCreate = planPayments.length;
  }

  // Customer refs on sales (resolveRef after customer plan is known).
  const planSalesResolved = planSales.filter((s) => {
    if (s.row.customerId === null) return true;
    const customerId = resolveRef(s.row.customerId, ownCustomerIds, "sales", `#${s.row.number}`);
    if (customerId === null) {
      report.entities.sales.invalid++;
      report.entities.sales.toCreate--;
      idMap.delete(s.row.id);
      return false;
    }
    (s as { customerId?: string | null }).customerId = customerId;
    return true;
  }) as { row: (typeof backup.sales)[number]; id: string; number: number; customerId: string | null }[];

  report.wouldCreate =
    planCustomers.length +
    planSuppliers.length +
    planProducts.length +
    planSalesResolved.length +
    planExpenses.length +
    planAdjustments.length +
    planPayments.length;

  if (modeParam === "dry_run") {
    return ok({ report });
  }

  // ---- merge: create everything inside one transaction ---------------------
  const created = { customers: 0, suppliers: 0, products: 0, sales: 0, expenses: 0, adjustments: 0, payments: 0 };

  await db.$transaction(async (tx) => {
    if (planCustomers.length > 0) {
      const res = await tx.customer.createMany({
        data: planCustomers.map(({ row: r, id: newId }) => ({
          id: newId,
          businessId,
          name: r.name,
          phone: r.phone ?? null,
          email: r.email ?? null,
          address: r.address ?? null,
          note: r.note ?? null,
          deletedAt: toDate(r.deletedAt) ?? null,
        })),
      });
      created.customers = res.count;
    }
    if (planSuppliers.length > 0) {
      const res = await tx.supplier.createMany({
        data: planSuppliers.map(({ row: r, id: newId }) => ({
          id: newId,
          businessId,
          name: r.name,
          phone: r.phone ?? null,
          email: r.email ?? null,
          address: r.address ?? null,
          note: r.note ?? null,
          deletedAt: toDate(r.deletedAt) ?? null,
        })),
      });
      created.suppliers = res.count;
    }
    if (planProducts.length > 0) {
      const res = await tx.product.createMany({
        data: planProducts.map(({ row: r, id: newId }) => ({
          id: newId,
          businessId,
          name: r.name,
          sku: r.sku ?? null,
          unit: r.unit ?? null,
          salePriceMinor: r.salePriceMinor,
          costPriceMinor: r.costPriceMinor,
          stockQty: r.stockQty,
          lowStockAt: r.lowStockAt,
          isActive: r.isActive,
          deletedAt: toDate(r.deletedAt) ?? null,
        })),
      });
      created.products = res.count;
    }
    for (const s of planSalesResolved) {
      await tx.sale.create({
        data: {
          id: s.id,
          businessId,
          number: s.number,
          customerId: s.customerId ?? null,
          subtotalMinor: s.row.subtotalMinor,
          discountMinor: s.row.discountMinor,
          totalMinor: s.row.totalMinor,
          paidMinor: s.row.paidMinor,
          status: s.row.status,
          issueDate: toDate(s.row.issueDate) ?? new Date(),
          note: s.row.note ?? null,
          deletedAt: toDate(s.row.deletedAt) ?? null,
          items: {
            create: s.row.items.map((i) => ({
              name: i.name,
              unit: i.unit ?? null,
              qty: i.qty,
              unitPriceMinor: i.unitPriceMinor,
              lineTotalMinor: i.lineTotalMinor,
              productId: i.productId === null ? null : (idMap.get(i.productId) ?? null),
            })),
          },
        },
      });
      created.sales++;
    }
    if (planExpenses.length > 0) {
      const res = await tx.expense.createMany({
        data: planExpenses.map(({ row: e, id: newId, supplierId }) => ({
          id: newId,
          businessId,
          supplierId,
          category: e.category,
          amountMinor: e.amountMinor,
          paidMinor: e.paidMinor,
          status: e.status,
          spentAt: toDate(e.spentAt) ?? new Date(),
          dueDate: toDate(e.dueDate) ?? null,
          reference: e.reference ?? null,
          note: e.note ?? null,
          deletedAt: toDate(e.deletedAt) ?? null,
        })),
      });
      created.expenses = res.count;
    }
    if (planAdjustments.length > 0) {
      const res = await tx.inventoryAdjustment.createMany({
        data: planAdjustments.map(({ row: a, id: newId, productId }) => ({
          id: newId,
          businessId,
          productId,
          delta: a.delta,
          reason: a.reason,
          createdAt: toDate(a.createdAt) ?? new Date(),
        })),
      });
      created.adjustments = res.count;
    }
    if (planPayments.length > 0) {
      const res = await tx.payment.createMany({
        data: planPayments.map(({ row: p, id: newId, saleId, expenseId }) => ({
          id: newId,
          businessId,
          saleId,
          expenseId,
          direction: p.direction,
          amountMinor: p.amountMinor,
          method: p.method,
          note: p.note ?? null,
          paidAt: toDate(p.paidAt) ?? new Date(),
        })),
      });
      created.payments = res.count;
    }
  });

  report.created =
    created.customers +
    created.suppliers +
    created.products +
    created.sales +
    created.expenses +
    created.adjustments +
    created.payments;

  await audit({
    businessId,
    actorId: ctx.userId,
    action: "data.import",
    entityType: "Business",
    entityId: businessId,
    before: null,
    after: {
      mode: "merge",
      ids: idsParam,
      created: report.created,
      skipped: report.wouldCreate - report.created,
      conflicts: conflicts.length,
      backupBusinessId: backup.business.id,
      currencyMatch,
    },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return ok({ report });
});

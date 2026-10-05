/**
 * Prompt 40 — client-safe stocktake DTOs + pure mappers (§116/§117).
 *
 * DTO LAWS:
 *  - explicit allowlist — never a raw Prisma object (§116);
 *  - every date is an ISO-8601 UTC string;
 *  - product snapshot fields come from the LINE (historical values, §19/§59);
 *  - NO password/MFA/session/IP/user-agent/platform/AI fields (§184).
 */
import type { StocktakeCountType, StocktakeStatus, StocktakeSummary } from "./types";
import { computeStocktakeSummary, isCountedLine, isStocktakeStatus } from "./types";

export type StocktakeCreatedBy = {
  id: string;
  name: string | null;
  email: string;
};

export type StocktakeCountedBy = {
  id: string;
  name: string | null;
  email: string;
};

export type StocktakeListItemDto = {
  id: string;
  reference: string;
  status: StocktakeStatus;
  countType: StocktakeCountType;
  lineCount: number;
  countedLineCount: number;
  netVarianceUnits: number;
  createdAt: string;
  createdBy: StocktakeCreatedBy | null;
};

export type StocktakeLineDto = {
  id: string;
  productId: string;
  productNameAtCount: string;
  skuAtCount: string | null;
  unitAtCount: string | null;
  systemQtyAtCount: number;
  /** Current Product.stockQty (page-load snapshot) — count-dialog preview.
   * The SERVER value saved at count time is always authoritative (§15). */
  currentStockQty: number | null;
  countedQty: number | null;
  varianceQty: number | null;
  countedAt: string | null;
  countedBy: StocktakeCountedBy | null;
};

export type StocktakeDetailDto = {
  id: string;
  reference: string;
  status: StocktakeStatus;
  countType: StocktakeCountType;
  notes: string | null;
  createdAt: string;
  startedAt: string | null;
  reviewedAt: string | null;
  finalizedAt: string | null;
  canceledAt: string | null;
  createdBy: StocktakeCreatedBy | null;
  summary: StocktakeSummary;
  lines: StocktakeLineDto[];
  linesPage: { page: number; pageSize: number; total: number };
};

/* ------------------------------- mappers ---------------------------------- */

type UserShape = { id: string; name: string | null; email: string } | null;

function userDto(user: UserShape): StocktakeCreatedBy | null {
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

export function stocktakeListItemDto(row: {
  id: string;
  reference: string;
  status: string;
  countType: string;
  _count?: { lines: number } | null;
  lines?: Array<{ countedAt: Date | string | null; varianceQty: number | null }> | null;
  createdAt: Date | string;
  createdByUser: UserShape;
}): StocktakeListItemDto {
  const lines = row.lines ?? [];
  const counted = lines.filter((l) => isCountedLine(l.countedAt)).length;
  const net = lines.reduce((acc, l) => acc + (isCountedLine(l.countedAt) && l.varianceQty != null ? l.varianceQty : 0), 0);
  return {
    id: row.id,
    reference: row.reference,
    status: isStocktakeStatus(row.status) ? row.status : "DRAFT",
    countType: "SELECTED", // §7 — the only count type that exists
    lineCount: row._count?.lines ?? lines.length,
    countedLineCount: counted,
    netVarianceUnits: net,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : row.createdAt.toISOString(),
    createdBy: userDto(row.createdByUser),
  };
}

export function stocktakeLineDto(row: {
  id: string;
  productId: string;
  productNameAtCount: string;
  skuAtCount: string | null;
  unitAtCount: string | null;
  systemQtyAtCount: number;
  countedQty: number;
  varianceQty: number;
  countedAt: Date | string | null;
  countedByUser: UserShape;
  /** Optional current-product join — used ONLY to give uncounted (DRAFT)
   * preparation lines a display name before the first count snapshots the
   * metadata (§19), and to preview the CURRENT system quantity in the count
   * dialog (the server re-reads stockQty at save — §15/§30). Counted lines
   * ALWAYS keep their historical snapshot. */
  product?: { name: string; sku: string | null; unit: string | null; stockQty: number } | null;
  /** Current Product.stockQty at page load — count-dialog preview (§15). */
  currentStockQty?: number | null;
}): StocktakeLineDto {
  const counted = isCountedLine(row.countedAt);
  const displayName = row.productNameAtCount || row.product?.name || "";
  const displaySku = row.skuAtCount ?? row.product?.sku ?? null;
  const displayUnit = row.unitAtCount ?? row.product?.unit ?? null;
  const currentStock = row.product?.stockQty ?? row.currentStockQty ?? null;
  return {
    id: row.id,
    productId: row.productId,
    productNameAtCount: displayName,
    skuAtCount: displaySku,
    unitAtCount: displayUnit,
    systemQtyAtCount: row.systemQtyAtCount,
    currentStockQty: currentStock,
    countedQty: counted ? row.countedQty : null,
    varianceQty: counted ? row.varianceQty : null,
    countedAt: !counted ? null : typeof row.countedAt === "string" ? row.countedAt : (row.countedAt as Date).toISOString(),
    countedBy: counted ? userDto(row.countedByUser) : null,
  };
}

export function stocktakeDetailDto(row: {
  id: string;
  reference: string;
  status: string;
  countType: string;
  notes: string | null;
  createdAt: Date | string;
  startedAt: Date | null;
  reviewedAt: Date | null;
  finalizedAt: Date | null;
  canceledAt: Date | null;
  createdByUser: UserShape;
  summary: StocktakeSummary;
  lines: Array<Parameters<typeof stocktakeLineDto>[0]>;
  linesPage: { page: number; pageSize: number; total: number };
}): StocktakeDetailDto {
  return {
    id: row.id,
    reference: row.reference,
    status: isStocktakeStatus(row.status) ? row.status : "DRAFT",
    countType: "SELECTED", // §7 — the only count type that exists
    notes: row.notes,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : row.createdAt.toISOString(),
    startedAt: isoOrNull(row.startedAt),
    reviewedAt: isoOrNull(row.reviewedAt),
    finalizedAt: isoOrNull(row.finalizedAt),
    canceledAt: isoOrNull(row.canceledAt),
    createdBy: userDto(row.createdByUser),
    summary: row.summary,
    lines: row.lines.map(stocktakeLineDto),
    linesPage: row.linesPage,
  };
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

export { computeStocktakeSummary };

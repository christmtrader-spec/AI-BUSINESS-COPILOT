import "server-only";

/**
 * Prompt 47 — server-side integration helpers for the quotation module.
 *
 * LAWS:
 *  - the ONE pure-domain-error → HTTP mapping for every quotation
 *    integrity failure (mirrors mapPureSalesOrderDomainError §22):
 *    corrupted persisted statuses / corrupted persisted quantities /
 *    missing snapshots / over-cap history are INTERNAL integrity failures
 *    (500) with stable codes — never ordinary user errors, never silently
 *    repaired, never mapped to a valid default (§8/§11/§12/§22).
 *  - this module is the ONLY place the quotation pure domain touches
 *    ApiError; route files never re-implement the mapping.
 */
import { ApiError } from "@/lib/api-helpers";
import {
  SalesQuotationIntegrityError,
  SalesQuotationStatusIntegrityError,
  SalesQuotationTotalOverflowError,
  SALES_QUOTATION_CORRUPT_HISTORY,
  SALES_QUOTATION_ERROR_CODES,
  SALES_QUOTATION_LINE_CAP_INVARIANT,
  SALES_QUOTATION_TOTAL_OVERFLOW,
} from "./types";

/**
 * Map pure quotation canonical-math/history integrity failures to their
 * controlled HTTP result. Exported for cross-module mapping (the
 * conversion path surfaces corruption through the SAME stable codes —
 * never a generic 500).
 */
export function mapPureSalesQuotationDomainError(error: unknown): never {
  if (error instanceof Error && error.name === "SalesQuotationStatusIntegrityError") {
    throw new ApiError(
      500,
      SALES_QUOTATION_ERROR_CODES.INVALID_PERSISTED_STATUS,
      "Sales quotation data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "SalesQuotationTotalOverflowError") {
    // Persisted-data overflow is corruption (input-time overflow is mapped
    // to the 422 by the write paths BEFORE anything persists).
    throw new ApiError(
      500,
      SALES_QUOTATION_TOTAL_OVERFLOW,
      "Sales quotation data is inconsistent. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "SalesQuotationIntegrityError") {
    if (error.message.includes(SALES_QUOTATION_LINE_CAP_INVARIANT)) {
      throw new ApiError(
        500,
        SALES_QUOTATION_LINE_CAP_INVARIANT,
        "Stored document data exceeds its configured line cap. Please contact support.",
      );
    }
    throw new ApiError(
      500,
      SALES_QUOTATION_CORRUPT_HISTORY,
      "Sales quotation data is inconsistent. Please contact support.",
    );
  }
  throw error;
}

/**
 * Re-throw a pure quotation integrity error through the ONE mapping;
 * non-integrity errors pass through unchanged. Convenience for call
 * sites that catch broadly.
 */
export function rethrowPureSalesQuotationDomainError(error: unknown): void {
  if (
    error instanceof SalesQuotationIntegrityError ||
    error instanceof SalesQuotationStatusIntegrityError ||
    error instanceof SalesQuotationTotalOverflowError
  ) {
    mapPureSalesQuotationDomainError(error);
  }
}

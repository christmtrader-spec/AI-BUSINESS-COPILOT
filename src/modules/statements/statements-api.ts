"use client";

/**
 * Prompt 39 — statement query keys + client fetchers (§54–§59/§157–§160).
 *
 * CACHE LAWS:
 *   §157 — every key carries businessId + partyId + from + to + cursor;
 *          locale is ALSO part of the key: descriptions are server-localized,
 *          so a language switch must never serve stale old-locale rows;
 *   §159 — the statement TYPE is part of the key: a Customer A statement is
 *          never reused for Supplier B;
 *   §158 — business switches invalidate everything (header-level), and a
 *          statement for a record that does not exist in the new business
 *          renders the honest not-found state (404).
 *   §160 — sale/payment/expense mutations invalidate the ["statements"]
 *          family through useInvalidateFinance (see finance-kit) — targeted,
 *          never the whole query client.
 */
import { api } from "@/lib/api-client";
import type { StatementResponseDto } from "@/lib/statements/dto";
import type { StatementTypeToken } from "@/lib/statements/types";

export type StatementPage = StatementResponseDto;

/** §157 — statementKeys.customer(...)/supplier(...); businessId is mandatory. */
export const statementKeys = {
  all: ["statements"] as const,
  customer: (
    businessId: string,
    partyId: string,
    from: string,
    to: string,
    cursor: string | null,
    locale: string,
  ) => ["statements", "customer", businessId, partyId, from, to, cursor ?? null, locale] as const,
  supplier: (
    businessId: string,
    partyId: string,
    from: string,
    to: string,
    cursor: string | null,
    locale: string,
  ) => ["statements", "supplier", businessId, partyId, from, to, cursor ?? null, locale] as const,
};

export function statementKeysFor(
  statementType: StatementTypeToken,
  businessId: string,
  partyId: string,
  from: string,
  to: string,
  cursor: string | null,
  locale: string,
) {
  return statementType === "customer"
    ? statementKeys.customer(businessId, partyId, from, to, cursor, locale)
    : statementKeys.supplier(businessId, partyId, from, to, cursor, locale);
}

export function statementApiPath(statementType: StatementTypeToken, partyId: string): string {
  return statementType === "customer"
    ? `/api/v1/customers/${partyId}/statement`
    : `/api/v1/suppliers/${partyId}/statement`;
}

/** Fetch one statement page (server-computed balances; client only renders). */
export async function fetchStatementPage(
  statementType: StatementTypeToken,
  partyId: string,
  opts: { from: string; to: string; cursor: string | null; locale: string },
): Promise<StatementPage> {
  const params = new URLSearchParams({ from: opts.from, to: opts.to, locale: opts.locale });
  if (opts.cursor) params.set("cursor", opts.cursor);
  return api<StatementPage>(`${statementApiPath(statementType, partyId)}?${params.toString()}`);
}

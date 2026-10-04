/**
 * Prompt 39 — statement API DTO contract (§30/§31/§32/§45).
 *
 * The API NEVER returns a raw Prisma object (§32): rows are the explicit
 * event DTO built by the engine, money fields are exact integers (§135),
 * and no note/platform/security/AI field can ever appear here because the
 * shape is closed.
 */
import type { StatementEventType } from "./types";

export type StatementRowDto = {
  /** Deterministic internal event id ("SALE:<id>", "PAYMENT_IN:<id>", …). */
  id: string;
  eventType: StatementEventType;
  /** ISO instant of the movement (business-timezone rendering is UI-only). */
  occurredAt: string;
  reference: string | null;
  description: string | null;
  increaseMinor: number;
  decreaseMinor: number;
  movementMinor: number;
  balanceAfterMinor: number;
};

export type StatementResponseDto = {
  statementType: "customer" | "supplier";
  party: { id: string; name: string };
  summary: {
    openingBalanceMinor: number;
    periodIncreaseMinor: number;
    periodDecreaseMinor: number;
    closingBalanceMinor: number;
    eventCount: number;
    truncated: boolean;
    from: string;
    to: string;
    timezone: string;
  };
  rows: StatementRowDto[];
  nextCursor: string | null;
  balanceBeforePageMinor: number;
};

/** Engine results are already DTO-shaped; this is the single narrowing point. */
export function toStatementResponse(result: {
  statementType: "customer" | "supplier";
  party: { id: string; name: string };
  summary: StatementResponseDto["summary"];
  rows: StatementRowDto[];
  nextCursor: string | null;
  balanceBeforePageMinor: number;
}): StatementResponseDto {
  return {
    statementType: result.statementType,
    party: { id: result.party.id, name: result.party.name },
    summary: { ...result.summary },
    rows: result.rows.map((row) => ({ ...row })),
    nextCursor: result.nextCursor,
    balanceBeforePageMinor: result.balanceBeforePageMinor,
  };
}

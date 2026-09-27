/**
 * AI-cost money utilities — Prompt 26 §21/§22.
 *
 * THE exact-arithmetic layer for AI provider cost. All values are BigInt
 * nano-minor units:
 *
 *     1 currency MINOR unit = 1,000,000 NANO-MINOR units
 *
 * (e.g. EUR: 1 nano-minor = 1e-6 cents = 1e-8 euro; IRR: 1 nano-minor =
 * 1e-6 Rial). Floats are structurally impossible here — this module accepts
 * and returns BigInt only and never touches Number arithmetic on money.
 *
 * Rounding policy (§20/§165 — documented, deterministic):
 *   Cost = ROUND_HALF_UP of the exact rational result, computed in integers.
 *   Given rate R (nano-minor per 1K tokens) and tokens T:
 *
 *       cost = roundHalfUp(R * T / 1000)
 *
 *   The numerator R*T and the divisor 1000 are exact BigInts; the quotient
 *   is rounded HALF-UP once, at the very end (never mid-calculation).
 *   Every monetary result is reproducible from (tokens, rateVersion, rate
 *   values, rounding mode) — §166.
 */

export const NANO_MINOR_PER_MINOR = 1_000_000n;
const DIVISOR_1K = 1000n;

/** Safe BigInt parser for values that must be non-negative integers. */
export function toBigIntSafe(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/** a + b — both must be non-negative BigInts (defensive against bugs). */
export function addNanoMinor(a: bigint, b: bigint): bigint {
  if (a < 0n || b < 0n) throw new Error("negative nano-minor value");
  return a + b;
}

/**
 * Exact cost of `tokens` tokens at `rateNanoMinorPer1K`:
 *   roundHalfUp(rate * tokens / 1000)
 * Single final rounding — no intermediate truncation (§20).
 */
export function multiplyRateByTokens(tokens: bigint, rateNanoMinorPer1K: bigint): bigint {
  if (tokens < 0n || rateNanoMinorPer1K < 0n) throw new Error("negative cost operand");
  const numerator = rateNanoMinorPer1K * tokens;
  // Integer ROUND_HALF_UP for a non-negative quotient:
  //   floor((numerator + divisor/2) / divisor)
  return (numerator + DIVISOR_1K / 2n) / DIVISOR_1K;
}

/** Divide by 1000 with explicit ROUND_HALF_UP (documented policy, §20). */
export function divideBy1000(value: bigint): bigint {
  if (value < 0n) throw new Error("negative nano-minor value");
  return (value + DIVISOR_1K / 2n) / DIVISOR_1K;
}

/** Divide by 1,000,000 with explicit ROUND_HALF_UP (display helpers only). */
export function divideBy1000000(value: bigint): bigint {
  if (value < 0n) throw new Error("negative nano-minor value");
  const D = NANO_MINOR_PER_MINOR;
  return (value + D / 2n) / D;
}

/** Explicit rounding alias — the single documented rounding mode. */
export function roundExact(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new Error("divisor must be positive");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const q = (abs + divisor / 2n) / divisor;
  return negative ? -q : q;
}

/**
 * Human/debug formatting ONLY (never accounting): "1.234567" in minor
 * units. Integer string manipulation — no floats.
 */
export function formatNanoMinor(value: bigint): string {
  if (value < 0n) throw new Error("negative nano-minor value");
  const minor = divideBy1000000(value);
  const frac = (value - minor * NANO_MINOR_PER_MINOR).toString().padStart(6, "0");
  return `${minor}.${frac}`;
}

/**
 * Convert nano-minor → minor units for DISPLAY ONLY (§22). Accounting never
 * uses this — the ledger stores nano-minor BigInts end-to-end.
 * Returns the truncated minor amount plus whether sub-minor residue exists,
 * so a caller can never silently pretend precision it lacks.
 */
export function convertToMinorDisplayOnly(value: bigint): {
  minor: bigint;
  hasSubMinorResidue: boolean;
} {
  if (value < 0n) throw new Error("negative nano-minor value");
  const minor = value / NANO_MINOR_PER_MINOR;
  return { minor, hasSubMinorResidue: value % NANO_MINOR_PER_MINOR !== 0n };
}

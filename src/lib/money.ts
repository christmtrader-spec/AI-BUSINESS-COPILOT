/**
 * Money utilities — Constitution A08.
 *
 * All authoritative money values are stored as INTEGER MINOR UNITS
 * (e.g. cents). Floating-point arithmetic is forbidden for money.
 * Every financial figure in the app flows through these helpers.
 */

export type CurrencyConfig = {
  currencyCode: string;
  currencySymbol: string;
  decimalPrecision: number; // 0..4
  locale?: string;
};

const MAX_PRECISION = 4;

export function clampPrecision(precision: number): number {
  return Math.min(Math.max(Math.trunc(precision), 0), MAX_PRECISION);
}

/** Scale factor for a precision: 2 -> 100 */
export function minorScale(precision: number): number {
  return 10 ** clampPrecision(precision);
}

/**
 * Convert a user-entered decimal amount (e.g. "12.34" or 12.34)
 * to integer minor units using string math where possible so we
 * never introduce float drift. Rounds half-up at sub-minor digits.
 */
export function toMinor(amount: number | string, precision: number): number {
  const digits = clampPrecision(precision); // decimal digit count (e.g. 2)
  const scale = minorScale(precision); // multiplier (e.g. 100)
  const str = String(amount).trim().replace(/,/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(str) || str === "" || str === "-" || str === ".") {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [intPart = "0", fracPartRaw = ""] = unsigned.split(".");
  // Keep digits+1 fraction chars: `digits` kept + 1 rounding witness.
  const fracPart = (fracPartRaw + "0".repeat(digits + 1)).slice(0, digits + 1);
  const whole = BigInt(intPart || "0") * BigInt(scale);
  const frac = BigInt(fracPart.slice(0, digits) || "0");
  // round half-up on the first discarded digit
  const firstDiscarded = Number(fracPart[digits] ?? "0");
  let minor = whole + frac + (firstDiscarded >= 5 ? BigInt(1) : BigInt(0));
  if (negative) minor = -minor;
  const n = Number(minor);
  if (!Number.isSafeInteger(n)) throw new Error("Amount out of safe range");
  return n;
}

/** Convert integer minor units to a JS number in major units (display only). */
export function fromMinor(minor: number, precision: number): number {
  if (!Number.isInteger(minor)) throw new Error("Minor units must be integers");
  return minor / minorScale(precision);
}

/** Deterministic integer arithmetic. */
export function addMinor(...values: number[]): number {
  return values.reduce<number>((acc, v) => {
    if (!Number.isInteger(v)) throw new Error("Minor units must be integers");
    return acc + v;
  }, 0);
}

export function subtractMinor(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error("Minor units must be integers");
  }
  return a - b;
}

/**
 * Format minor units for display using the business currency config.
 * Purely a presentation concern — storage stays integer.
 */
export function formatMoney(
  minor: number,
  config: CurrencyConfig,
  options?: { locale?: string; withCode?: boolean },
): string {
  const precision = clampPrecision(config.decimalPrecision);
  const major = fromMinor(minor, precision);
  const locale = options?.locale ?? config.locale ?? "en";
  const formatted = new Intl.NumberFormat(locale === "fa" ? "fa-IR" : locale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(Math.abs(major));
  const sign = major < 0 ? "-" : "";
  const withSymbol = `${sign}${config.currencySymbol}${formatted}`;
  return options?.withCode ? `${withSymbol} ${config.currencyCode}` : withSymbol;
}

/** Zero in minor units. */
export function zeroMinor(): number {
  return 0;
}

/**
 * Derive payment status from integer totals (single source of truth).
 * Used by the payments pipeline; never accepted from client input.
 */
export type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";

export function statusOf(totalMinor: number, paidMinor: number): PaymentStatus {
  if (!Number.isInteger(totalMinor) || !Number.isInteger(paidMinor)) {
    throw new Error("Minor units must be integers");
  }
  if (paidMinor <= 0) return "UNPAID";
  if (paidMinor >= totalMinor) return "PAID";
  return "PARTIAL";
}

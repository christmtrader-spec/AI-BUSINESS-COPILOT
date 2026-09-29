/**
 * Money serialization for data portability — Prompt 31 §77/§226/§227/§157.
 *
 * LAW (Constitution A08): money is an integer minor unit, NEVER a float.
 *  - JSON exports carry minor integers directly (machine authority, §226).
 *  - CSV carries an exact DECIMAL STRING consistent with the business
 *    decimal precision (human portability, §227); import parses the string
 *    back with pure integer arithmetic — no floating point anywhere (§77).
 */

export class MoneyParseError extends Error {
  constructor(
    public code: "MONEY_EMPTY" | "MONEY_FORMAT" | "MONEY_TOO_PRECISE" | "MONEY_OUT_OF_RANGE",
    message: string,
  ) {
    super(message);
  }
}

/** Format an integer minor-unit amount as an exact decimal string. */
export function formatMinorToDecimal(minor: number, decimalPrecision: number): string {
  if (!Number.isSafeInteger(minor)) throw new MoneyParseError("MONEY_OUT_OF_RANGE", "Amount out of range.");
  const precision = Math.max(0, Math.min(6, decimalPrecision));
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const divisor = 10 ** precision;
  const whole = Math.floor(abs / divisor);
  const frac = abs % divisor;
  const fracStr = precision === 0 ? "" : `.${String(frac).padStart(precision, "0")}`;
  return `${negative ? "-" : ""}${whole}${fracStr}`;
}

/**
 * Parse a decimal string into integer minor units using EXACT integer
 * arithmetic on the string parts (no Number() on the full value).
 * Accepts optional leading +/-, digits, and at most `precision` decimals.
 * Rejects thousands separators, currency symbols, exponent notation, NaN.
 */
export function parseDecimalToMinor(input: string, decimalPrecision: number): number {
  const precision = Math.max(0, Math.min(6, decimalPrecision));
  const raw = input.trim();
  if (raw === "") throw new MoneyParseError("MONEY_EMPTY", "Amount is empty.");
  if (/e/i.test(raw) || /,/.test(raw) || /[^\d+.\-]/.test(raw)) {
    throw new MoneyParseError("MONEY_FORMAT", "Amount is not an exact decimal.");
  }
  const match = /^([+-]?)(\d+)?(?:\.(\d+))?$/.exec(raw);
  if (!match || (!match[2] && !match[3])) {
    throw new MoneyParseError("MONEY_FORMAT", "Amount is not an exact decimal.");
  }
  const sign = match[1] === "-" ? -1 : 1;
  const wholePart = match[2] ?? "0";
  const fracPart = match[3] ?? "";
  if (fracPart.length > precision) {
    throw new MoneyParseError("MONEY_TOO_PRECISE", `Amount has more than ${precision} decimal place(s).`);
  }
  const fracPadded = fracPart.padEnd(precision, "0");
  const wholeDigits = (wholePart === "" ? "0" : wholePart).replace(/^0+(?=\d)/, "");
  const minor = Number(wholeDigits + (precision === 0 ? "" : fracPadded));
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyParseError("MONEY_OUT_OF_RANGE", "Amount out of range.");
  }
  return sign * minor;
}

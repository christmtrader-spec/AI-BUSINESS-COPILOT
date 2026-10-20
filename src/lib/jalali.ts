/**
 * Jalali (Solar Hijri) calendar — pure, dependency-free conversion + helpers.
 *
 * Prompt 52 §F4: report date-range presets in the Jalali calendar
 * ("this month / last month / this quarter / last 3 months"). The SERVER
 * report-periods law stays Gregorian `YYYY-MM-DD` keys exclusively; this
 * module is the conversion boundary used by the UI to compute Gregorian
 * from/to keys from Jalali presets/inputs.
 *
 * Algorithm: the well-known Khayyam–Borkowski table-free method used by
 * jalaali-js (public domain), reimplemented here in strict TypeScript with
 * no external imports so the locked lockfile stays untouched.
 *
 * All functions are pure. Ranges are validated like report-periods (no
 * future-only ranges at the UI layer — the server re-validates anyway).
 */

export type JalaliDate = { jy: number; jm: number; jd: number };

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192,
  2262, 2324, 2394, 2456, 3178,
];

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  if (jy < jp || jy >= BREAKS[bl - 1]) {
    throw new Error(`Invalid Jalali year: ${jy}`);
  }
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn: number): JalaliDate {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let jd: number;
  let jm: number;
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = mod(k, 31) + 1;
      return { jy, jm, jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + div(k, 30);
  jd = mod(k, 30) + 1;
  return { jy, jm, jd };
}

/** Gregorian Date (UTC components) -> Jalali date. */
export function toJalali(date: Date): JalaliDate {
  return d2j(g2d(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
}

/** Jalali date -> Gregorian Date at UTC midnight. */
export function toGregorian(jy: number, jm: number, jd: number): Date {
  const jdn = j2d(jy, jm, jd);
  const g = d2g(jdn);
  return new Date(Date.UTC(g.gy, g.gm - 1, g.gd));
}

export function isJalaliLeap(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

/** Days in a Jalali month: months 1-6 have 31, 7-11 have 30, 12 has 29/30. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm < 1 || jm > 12) throw new Error(`Invalid Jalali month: ${jm}`);
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeap(jy) ? 30 : 29;
}

/**
 * A Jalali month begins on Farvardin 1 (spring). For a Gregorian reference
 * Date, return {jy, jm} of the month containing it.
 */
export function jalaliMonthOf(date: Date): { jy: number; jm: number } {
  const { jy, jm } = toJalali(date);
  return { jy, jm };
}

/**
 * First day (Gregorian Date, UTC midnight) of the Jalali month containing
 * `date`.
 */
export function jalaliMonthStart(date: Date): Date {
  const { jy, jm } = toJalali(date);
  return toGregorian(jy, jm, 1);
}

/** First day of the Jalali month AFTER the month containing `date`. */
export function jalaliNextMonthStart(date: Date): Date {
  const { jy, jm } = toJalali(date);
  const nm = jm === 12 ? 1 : jm + 1;
  const ny = jm === 12 ? jy + 1 : jy;
  return toGregorian(ny, nm, 1);
}

/**
 * Start of the Jalali quarter (سهماهه) containing `date`. Quarters:
 * 1: فروردین-خرداد, 2: تیر-شهریور, 3: مهر-آذر, 4: دی-اسفند.
 */
export function jalaliQuarterStart(date: Date): Date {
  const { jy, jm } = toJalali(date);
  const qFirst = [1, 4, 7, 10][(jm - 1) / 3 | 0] ?? 1;
  return toGregorian(jy, qFirst, 1);
}

/** Jalali months names (Persian) and short English transliteration. */
export const JALALI_MONTHS_FA = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

export const JALALI_MONTHS_EN = [
  "Farvardin", "Ordibehesht", "Khordad", "Tir", "Mordad", "Shahrivar",
  "Mehr", "Aban", "Azar", "Dey", "Bahman", "Esfand",
] as const;

/** Zero-padded 4-2-2 formatting: 1403/07/01 */
export function formatJalaliKey(j: JalaliDate): string {
  const mm = String(j.jm).padStart(2, "0");
  const dd = String(j.jd).padStart(2, "0");
  return `${j.jy}/${mm}/${dd}`;
}

/**
 * Format a Jalali date for display: "1403/07/01" (numeric) or
 * "۱ مهر ۱۴۰۳" (long, fa) / "1 Mehr 1403" (long, en).
 */
export function formatJalaliDisplay(
  j: JalaliDate,
  opts?: { long?: boolean; locale?: "fa" | "en"; digits?: boolean },
): string {
  if (opts?.long) {
    const monthIndex = j.jm - 1;
    if (opts.locale === "fa") {
      const day = opts.digits === false ? j.jd : toPersianDigits(j.jd);
      const year = opts.digits === false ? j.jy : toPersianDigits(j.jy);
      return `${day} ${JALALI_MONTHS_FA[monthIndex]} ${year}`;
    }
    return `${j.jd} ${JALALI_MONTHS_EN[monthIndex]} ${j.jy}`;
  }
  if (opts?.locale === "fa" && opts?.digits !== false) {
    return toPersianDigits(formatJalaliKey(j));
  }
  return formatJalaliKey(j);
}

/** Convert Latin digits to Persian digits (presentation only). */
export function toPersianDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) + 0x06f0 - 0x0030),
  );
}

/**
 * Preset windows — the heart of §F4. Each preset returns INCLUSIVE
 * Gregorian YYYY-MM-DD keys (the server report-periods format), computed
 * from the Jalali calendar anchored on `now`.
 */
export type JalaliPresetKey =
  | "thisMonth"
  | "lastMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "last3Months"
  | "thisYear"
  | "lastYear";

function keyOfUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function jalaliPresetWindow(
  preset: JalaliPresetKey,
  now: Date,
): { from: string; to: string; label: string } {
  const { jy, jm } = toJalali(now);
  const monthStart = (y: number, m: number) => toGregorian(y, m, 1);
  const monthEnd = (y: number, m: number) => {
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    const next = toGregorian(nextY, nextM, 1);
    return new Date(next.getTime() - 86_400_000);
  };
  switch (preset) {
    case "thisMonth":
      return {
        from: keyOfUtc(monthStart(jy, jm)),
        to: keyOfUtc(monthEnd(jy, jm)),
        label: "thisMonth",
      };
    case "lastMonth": {
      const pm = jm === 1 ? 12 : jm - 1;
      const py = jm === 1 ? jy - 1 : jy;
      return {
        from: keyOfUtc(monthStart(py, pm)),
        to: keyOfUtc(monthEnd(py, pm)),
        label: "lastMonth",
      };
    }
    case "thisQuarter": {
      const qFirst = [1, 4, 7, 10][Math.floor((jm - 1) / 3)] ?? 1;
      const qLast = Math.min(qFirst + 2, 12);
      return {
        from: keyOfUtc(monthStart(jy, qFirst)),
        to: keyOfUtc(monthEnd(jy, qLast)),
        label: "thisQuarter",
      };
    }
    case "lastQuarter": {
      const qFirstIdx = Math.floor((jm - 1) / 3);
      const prevQFirstIdx = qFirstIdx === 0 ? 3 : qFirstIdx - 1;
      const qFirst = [1, 4, 7, 10][prevQFirstIdx];
      const qLast = qFirst + 2;
      const qy = qFirstIdx === 0 ? jy - 1 : jy;
      return {
        from: keyOfUtc(monthStart(qy, qFirst)),
        to: keyOfUtc(monthEnd(qy, qLast)),
        label: "lastQuarter",
      };
    }
    case "last3Months": {
      // The last three Jalali months INCLUDING the current one.
      let startM = jm - 2;
      let sy = jy;
      if (startM <= 0) {
        startM += 12;
        sy = jy - 1;
      }
      const endY = jy;
      const endM = jm;
      return {
        from: keyOfUtc(monthStart(sy, startM)),
        to: keyOfUtc(monthEnd(endY, endM)),
        label: "last3Months",
      };
    }
    case "thisYear":
      return {
        from: keyOfUtc(monthStart(jy, 1)),
        to: keyOfUtc(monthEnd(jy, 12)),
        label: "thisYear",
      };
    case "lastYear":
      return {
        from: keyOfUtc(monthStart(jy - 1, 1)),
        to: keyOfUtc(monthEnd(jy - 1, 12)),
        label: "lastYear",
      };
    default: {
      const exhaustive: never = preset;
      throw new Error(`Unknown preset: ${exhaustive}`);
    }
  }
}

export const JALALI_PRESETS: readonly JalaliPresetKey[] = [
  "thisMonth",
  "lastMonth",
  "thisQuarter",
  "lastQuarter",
  "last3Months",
  "thisYear",
  "lastYear",
];

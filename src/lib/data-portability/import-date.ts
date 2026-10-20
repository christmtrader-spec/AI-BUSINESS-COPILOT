/**
 * Pure import-parsing laws (NO server-only, NO db) — safe to import from
 * server validators AND pure unit scripts. R61-7.
 *
 * Iranian software exports often carry Persian/Arabic digits and Arabic
 * decimal/thousands separators; this module normalizes them and parses
 * dates with Jalali auto-detect. Strictly-widening guarantee: every
 * previously-accepted validator input is unchanged (money-csv.ts itself is
 * a red-line file and stays untouched — normalization happens upstream).
 */
import { toGregorian, toJalali } from "@/lib/jalali";

const PERSIAN_DIGIT_MAP: Record<string, string> = {};
for (let i = 0; i < 10; i++) {
  PERSIAN_DIGIT_MAP[String.fromCharCode(0x06f0 + i)] = String(i); // ۰-۹
  PERSIAN_DIGIT_MAP[String.fromCharCode(0x0660 + i)] = String(i); // ٠-٩
}

/**
 * Persian/Arabic digit + separator normalization:
 *  - ۰-۹ (U+06F0–9) and ٠-٩ (U+0660–9) → ASCII digits
 *  - ٫ (U+066B, Arabic decimal separator) → "."
 *  - ٬ (U+066C, Arabic thousands separator) → "," then stripped when
 *    thousands-positional (`,` followed by exactly 3 digits).
 * Ambiguous European "1.234,56" stays comma-carrying → money parser still
 * rejects it (comma mapping is thousands-only, never decimal).
 */
export function normalizePersianNumeric(input: string): string {
  let out = "";
  for (const ch of input) {
    if (ch === "\u066b") out += ".";
    else if (ch === "\u066c") out += ",";
    else out += PERSIAN_DIGIT_MAP[ch] ?? ch;
  }
  return out.replace(/,(?=\d{3}\b)/g, "");
}

/**
 * Date parser with Jalali auto-detect → ISO YYYY-MM-DD (UTC).
 * Resolution law (R61-7, disambiguation):
 *  - jy/jm/jd with ANY separator (/ - .) whose year falls in the Jalali
 *    window (1278–1500 ⇒ 1899–2121 CE) is parsed as JALALI — in Iranian
 *    business documents a year like 1404 always means Solar Hijri.
 *  - Otherwise YYYY-MM-DD (optionally with a time part — date wins) is
 *    parsed as Gregorian ISO.
 * Persian digits accepted everywhere. Everything else → null (caller maps
 * to ROW_INVALID_DATE). A Jalali day that does not exist (non-leap Esfand
 * 30) is rejected via round-trip guard — never a silent rollover.
 */
export function parseImportDate(rawInput: string): string | null {
  const raw = normalizePersianNumeric(rawInput.trim());
  if (raw === "") return null;

  // Jalali FIRST — jy/jm/jd with / - . separators; the year window decides.
  const jal = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(raw);
  if (jal) {
    const jy = Number(jal[1]);
    const jm = Number(jal[2]);
    const jd = Number(jal[3]);
    if (jy >= 1278 && jy <= 1500) {
      if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
      const g = toGregorian(jy, jm, jd);
      const iso = g.toISOString().slice(0, 10);
      // Round-trip guard: the Jalali day must actually exist.
      const back = toJalali(g);
      if (back.jy !== jy || back.jm !== jm || back.jd !== jd) return null;
      return iso;
    }
  }

  // Gregorian ISO — take the date part even with a time attached.
  const greg = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(raw);
  if (greg) {
    const y = Number(greg[1]);
    const m = Number(greg[2]);
    const d = Number(greg[3]);
    if (y < 1000 || y > 3000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
      return null; // e.g. 2026-02-31 — honest rejection, no silent rollover
    }
    return `${greg[1]}-${greg[2]}-${greg[3]}`;
  }

  return null;
}

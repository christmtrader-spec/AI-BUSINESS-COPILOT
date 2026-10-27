/**
 * R120 — pre-formatted window range labels for the copilot snapshot.
 *
 * PURE module (no React, no i18n runtime, no server imports) so
 * scripts/r120-window-label-check.ts can unit-test it headlessly under bun.
 *
 * WHY: the AI snapshot hands the model raw `YYYY-MM-DD` window bounds, and
 * when the model narrated a Persian answer it converted the Gregorian dates
 * to the Jalali calendar ITSELF — live QA caught "از ۲۶ این تا ۲۴ شهریتم"
 * (invented month names). The fix follows the SAME law as the money strings
 * (Constitution A11-A13): every string the model could mangle arrives
 * pre-formatted from the server, and the prompt forbids re-deriving it.
 *
 * fa → Jalali long form with Persian digits: "۳ مهر ۱۴۰۵ تا ۲ آبان ۱۴۰۵"
 * en → Gregorian medium form:                "25 Sep 2026 to 24 Oct 2026"
 * A single-day window renders the date once (no "X to X" stutter).
 * Anything that is not a clean `YYYY-MM-DD` yields null — the caller omits
 * the label (honest absence) instead of shipping a malformed string.
 */
import { toJalali, formatJalaliDisplay } from "./jalali";

const ISO_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Hand-rolled 3-letter months — Intl "short" varies by ICU ("Sept" vs "Sep");
 *  the label must be byte-identical across runtimes (same law as the jalali lib). */
const EN_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Parse a business-local `YYYY-MM-DD` key at UTC midnight (toJalali reads UTC components). */
function parseIsoKey(iso: string): Date | null {
  if (!ISO_KEY.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function enDay(d: Date): string {
  return `${d.getUTCDate()} ${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatWindowLabel(
  fromIso: string,
  toIso: string,
  locale: "fa" | "en",
): string | null {
  const from = parseIsoKey(fromIso);
  const to = parseIsoKey(toIso);
  if (!from || !to) return null;

  if (locale === "fa") {
    const jf = formatJalaliDisplay(toJalali(from), { long: true, locale: "fa" });
    if (fromIso === toIso) return jf;
    const jt = formatJalaliDisplay(toJalali(to), { long: true, locale: "fa" });
    return `${jf} تا ${jt}`;
  }

  if (fromIso === toIso) return enDay(from);
  return `${enDay(from)} to ${enDay(to)}`;
}

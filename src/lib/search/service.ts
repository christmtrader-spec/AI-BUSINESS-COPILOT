/**
 * Prompt 33 — search orchestration service (§6/§7/§8/§9).
 *
 * Pipeline: validate (schema) → normalize → bounded Prisma prefilter
 * (query.ts) → JS verification + ranking (rank.ts) → dedupe → global cap
 * → grouped DTO. Deterministic end-to-end.
 *
 * Observability (§22): the raw query is NEVER logged — search strings may
 * contain emails, phone numbers, invoice numbers and private business
 * terms. Only counts/timing are emitted via the fixed event vocabulary.
 */
import "server-only";
import { logDebug } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { normalizeSearchText, extractInvoiceNumberQuery, getSearchVariants } from "./normalize";
import { compareRanked, dedupeCandidates, rankCandidate, RANK_WEIGHTS } from "./rank";
import { groupResults } from "./group";
import { ENTITY_DESTINATION, type SearchCandidate, type SearchEntityType, type SearchInput, type SearchResponseData, type SearchResultItem } from "./types";
import { fetchSearchCandidates } from "./query";

/**
 * Server-localized display label for Payment rows (§5.6). The user's
 * persisted locale is resolved by the route (same pattern as the Prompt 32
 * notification renderer); the label is plain text, never HTML.
 */
const PAYMENT_LABELS = { en: "Payment", fa: "پرداخت" } as const;
export type SearchLocale = keyof typeof PAYMENT_LABELS;

/** Pure grouping lives in group.ts (re-exported for service callers). */
export { groupResults } from "./group";

function toItems(candidates: SearchCandidate[]) {
  return candidates.map((c) => ({
    id: c.id,
    type: c.type,
    title: c.title,
    subtitle: c.subtitle,
    destination: ENTITY_DESTINATION[c.type],
    status: c.status,
    date: c.date,
    direction: c.direction,
    method: c.method,
  }));
}

/**
 * Execute a tenant-scoped search. `input` must come from
 * parseSearchParams; `businessId` MUST be the server-derived context value.
 */
export async function searchBusiness(
  businessId: string,
  input: SearchInput,
  options: { locale: SearchLocale },
): Promise<SearchResponseData> {
  const startedAt = Date.now();
  const normalized = normalizeSearchText(input.q);
  const variants = getSearchVariants(normalized);
  const numericInvoice = extractInvoiceNumberQuery(normalized);

  // §6 — bounded, concurrent prefilter (≤ 48 candidate rows).
  const rows = await fetchSearchCandidates({
    businessId,
    types: input.types,
    variants,
    numericInvoice,
    paymentLabel: PAYMENT_LABELS[options.locale] ?? PAYMENT_LABELS.en,
  });

  // Verify + rank in JS (the DB LIKE prefilter is deliberately wider than
  // the final match decision — normalized/variant matching decides here).
  const qNorm = variants[0] ?? normalized;
  const ranked: { candidate: SearchCandidate; score: number }[] = [];
  for (const candidate of dedupeCandidates(rows)) {
    const reason = rankCandidate(candidate, variants, numericInvoice);
    if (reason === null) continue; // not a real match → dropped
    ranked.push({ candidate, score: RANK_WEIGHTS[reason] });
  }
  ranked.sort(compareRanked);

  // Global cap (§6) — max `limit` (≤ 30) results leave the server.
  const limited = ranked.slice(0, input.limit);
  const items = toItems(limited.map((r) => r.candidate));
  const groups = groupResults(items);
  const total = items.length;
  const truncated = ranked.length > limited.length;

  // §22 — safe metrics only: counts + duration. Never the query text,
  // never the variants, never result contents.
  logDebug(OPERATIONAL_EVENTS.searchExecuted, {
    route: "/api/v1/search",
    resultCount: total,
    groupCount: groups.length,
    truncated,
    durationMs: Date.now() - startedAt,
  });

  return { query: input.q, groups, total, truncated };
}

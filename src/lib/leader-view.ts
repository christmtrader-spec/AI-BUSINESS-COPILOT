/**
 * R96 — the LEADER VIEW-MODEL: rank 1 of a whole-book leaders fact, as the
 * copilot's stream meta and the balances views read it.
 *
 * ZERO imports by construction — this module is imported by BOTH server
 * code (src/lib/ai/snapshot.ts builds the stream meta) and client code
 * (src/modules/balances/balances-data.ts maps the /api/v1/receivables and
 * /api/v1/payables `leaders` field), so it must never pull the db or any
 * server-only module (the r93 client-safety law; enforced by the r96 unit
 * harness's static check).
 *
 * THE LAW (R95 carried forward): a leaders fact is the ranked top slice of
 * the EXACT R89 board order over a WHOLE-BOOK scan. `null` means "we could
 * not see the whole book" (a truncated read) or "the book has no open
 * balances" — in BOTH cases every reader stays honestly silent: a wrong
 * leader is worse than no leader. `partyName: null` is the unassigned mass
 * leading — real money with no party recorded; each caller renders its own
 * honest "unassigned" label.
 *
 * This extractor NEVER re-ranks: the fact's own order is the law, and the
 * view takes `leaders[0]` verbatim (proven by the r96 unit harness over a
 * deliberately shuffled fact — there is no second ranking law).
 */

/** The ranked-leaders fact shape (structural — matches party-aging's
 *  `BookLeadersFact` without importing it, so this file stays pure). */
export type LeadersFactInput = {
  leaders:
    | Array<{
        rank: number;
        partyId: string | null;
        partyName: string | null;
        outstandingMinor: number;
        count: number;
      }>
    | null;
  /** EVERY distinct party seen in the ranking (never the slice length). */
  partyCount: number;
} | null;

/** Rank 1 as the meta/UI views read it: the leader's identity (null name =
 *  the unassigned mass), its EXACT integer outstanding in minor units (A08
 *  — never a float), how many open items fold into it, and the size of the
 *  whole ranked population (partyCount, never the top slice length). */
export type BookLeaderView = {
  partyName: string | null;
  outstandingMinor: number;
  openItems: number;
  partyCount: number;
};

/**
 * PURE — rank 1 of the leaders fact, or null when the fact itself is
 * silent (absent / truncated / empty book). Never throws; never invents
 * figures; never re-ranks.
 */
export function topLeaderOfFact(
  fact: LeadersFactInput,
): BookLeaderView | null {
  const first = fact?.leaders?.[0];
  if (!first) return null;
  return {
    partyName: first.partyName,
    outstandingMinor: first.outstandingMinor,
    openItems: first.count,
    partyCount: fact?.partyCount ?? 0,
  };
}

/* ---------------------------------------------------------------------------
 * R97 — THE PODIUM. The same fact, one slice deeper: ranks 1..take of the
 * book-leaders fact as the balances strips and the copilot's "who else?"
 * chips read it. The silence law carries verbatim: a null fact (truncated
 * read or empty book) yields an EMPTY podium — never a partial podium, never
 * an invented row. The slice NEVER re-ranks: `leaders[1]` is rank 2 because
 * the server said so, not because this file compared anything.
 * ------------------------------------------------------------------------- */

/** One podium row: the BookLeaderView shape plus the two fields the drills
 *  and the rank labels need — the server's OWN rank (never recomputed) and
 *  the party id (null = the unassigned mass; a mass row renders but never
 *  drills to a party-scoped board, there is no party to scope to). */
export type BookPodiumEntry = BookLeaderView & {
  rank: number;
  partyId: string | null;
};

/**
 * PURE — the top-`take` podium of the leaders fact ([] when the fact is
 * silent or take ≤ 0). Never throws; never invents; never re-ranks; the
 * fact's own order IS the podium's order.
 */
export function topLeadersOfFact(
  fact: LeadersFactInput,
  take: number,
): BookPodiumEntry[] {
  const leaders = fact?.leaders;
  if (!leaders || !Number.isFinite(take) || take <= 0) return [];
  const partyCount = fact?.partyCount ?? 0;
  return leaders.slice(0, Math.floor(take)).map((l) => ({
    rank: l.rank,
    partyId: l.partyId,
    partyName: l.partyName,
    outstandingMinor: l.outstandingMinor,
    openItems: l.count,
    partyCount,
  }));
}

/**
 * PURE — the RUNNERS-UP (ranks 2..take): what the "who else?" chips and the
 * podium rows below the leader read. The leader row keeps its own dedicated
 * strip (topLeaderOfFact), so the runners-up deliberately EXCLUDE rank 1 —
 * one authority per surface, never a duplicated citation.
 */
export function runnersUpOfFact(
  fact: LeadersFactInput,
  take: number,
): BookPodiumEntry[] {
  return topLeadersOfFact(fact, take).filter((e) => e.rank !== 1);
}

/**
 * R113 — canonical spawn-why grouping for guard events (client-safe).
 *
 * WHY THIS EXISTS: the GuardCard's "Self-heals" chip counted
 * `spawnWhy === "down"` since R109 — but the daemon's REAL token is
 * `down-selfheal` (scripts/dev-rss-guard.cjs spawns
 * `spawnDevServer("down-selfheal")`). The synthetic battery fixtures said
 * "down", so tests passed while the production chip read 0 forever.
 *
 * LAW: spawnWhy stays RAW everywhere (the guard's own token, never
 * rewritten); grouping is a separate, explicit step through this pure
 * helper — one canonical mapping for UI + analytics + batteries.
 *
 * This module is deliberately dependency-free (no node:fs) so client
 * components can import it without dragging server-only modules into the
 * browser bundle.
 */

export type SpawnGroup = "recycle" | "selfheal" | "other";

/**
 * Group a raw spawnWhy token.
 *  - "recycle"             → "recycle" (the controlled water-mark recycle)
 *  - "down-selfheal"       → "selfheal" (the daemon's real self-heal token)
 *  - "down"                → "selfheal" (legacy fixture token, R109-era tests)
 *  - undefined             → undefined (event is not a spawn)
 *  - anything else         → "other" (future tokens stay visible, never crash)
 */
export function spawnGroupOf(why: string | undefined): SpawnGroup | undefined {
  if (why === undefined) return undefined;
  if (why === "recycle") return "recycle";
  if (why === "down-selfheal" || why === "down") return "selfheal";
  return "other";
}

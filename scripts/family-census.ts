/**
 * family-census.ts — the ONE source for the regression family's suite
 * counts, parsed from scripts/run-family.sh's own arrays (R173 §3
 * priority #1: end the census re-pin ritual — three consecutive rounds
 * went RED only because a battery hard-coded the previous family size).
 *
 * Every battery that needs the family census IMPORTS this module instead
 * of hard-coding a count; the counts can never drift from the runner
 * because they ARE the runner's arrays, read at battery-run time.
 *
 * Usage (tsx batteries):
 *   import { familyCensus } from "./family-census";
 *   const c = familyCensus();
 *   ok("census", c.tsx >= 23 && c.bun === 2 && c.proofs === 5);
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FamilyCensus = {
  /** tsx batteries registered in BATTERIES_TSX */
  tsx: number;
  /** TLA-pinned bun batteries in BATTERIES_BUN */
  bun: number;
  /** real-HTTP api-proofs in PROOFS */
  proofs: number;
  /** every battery filename found across all three arrays */
  names: string[];
};

function grabArray(sh: string, name: string): string[] {
  const m = sh.match(new RegExp(`${name}=\\([\\s\\S]*?\\)`));
  if (!m) return [];
  return m[0].match(/\br\d+-[a-z-]+\.ts\b/g) ?? [];
}

/** Parse the runner's arrays — the counts ARE the runner, never a copy. */
export function familyCensus(shPath = "scripts/run-family.sh"): FamilyCensus {
  const sh = readFileSync(join(process.cwd(), shPath), "utf8");
  const tsx = grabArray(sh, "BATTERIES_TSX");
  const bun = grabArray(sh, "BATTERIES_BUN");
  const proofs = grabArray(sh, "PROOFS");
  return {
    tsx: tsx.length,
    bun: bun.length,
    proofs: proofs.length,
    names: [...tsx, ...bun, ...proofs],
  };
}

/**
 * The self-registration canary (R174): a battery asserts ITS OWN filename
 * is registered in the runner — the join day's forgetting mode, moved to
 * the one file that can actually forget it.
 */
export function assertRegistered(batteryFile: string, shPath = "scripts/run-family.sh"): boolean {
  const sh = readFileSync(join(process.cwd(), shPath), "utf8");
  return sh.includes(batteryFile);
}

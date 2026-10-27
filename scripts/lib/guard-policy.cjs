/**
 * R112 — RSS-guard GRACE policy (pure, requireable, unit-testable).
 *
 * WHY: battery chains touch every app route, so a fresh server generation
 * walks its compile plateau (2.0–2.7GB observed) right after spawn. With a
 * flat 2450MB water the guard sometimes fired a CONTROLLED recycle 90s into
 * a chain — killing the running battery (R111: r65 died racing one; smoke
 * hit a self-heal window). A short post-spawn grace with HEADROOM above the
 * base water lets the compile storm pass while still catching genuine
 * runaways (the elevated window is bounded and short).
 *
 * LAW: grace applies ONLY after a spawn (recycle or down-selfheal) — never
 * at daemon boot, so a pre-existing runaway is still judged by the strict
 * base water. The daemon tracks samplesSinceSpawn; this module turns that
 * counter into the effective water for the sample.
 */

/** Daemon defaults — env-overridable like the other ops knobs. */
const GRACE_SAMPLES_DEFAULT = 4; // ≈2 min at the 30s cadence
const GRACE_HEADROOM_MB_DEFAULT = 300; // above the R107-tuned base water

/**
 * Effective water for one sample.
 * @param {object} p
 * @param {number} p.baseWaterMb        steady-state water (e.g. 2450)
 * @param {number} p.samplesSinceSpawn  0 = the spawn just happened
 * @param {number} [p.graceSamples]     how many samples enjoy headroom
 * @param {number} [p.graceHeadroomMb]  extra MB allowed during grace
 * @returns {{inGrace: boolean, effWaterMb: number}}
 */
function effectiveWaterMb({
  baseWaterMb,
  samplesSinceSpawn,
  graceSamples = GRACE_SAMPLES_DEFAULT,
  graceHeadroomMb = GRACE_HEADROOM_MB_DEFAULT,
}) {
  const base = Number(baseWaterMb) || 0;
  const since = Number(samplesSinceSpawn);
  const samples = Number(graceSamples);
  const headroom = Number(graceHeadroomMb);
  const inGrace =
    Number.isFinite(since) &&
    since >= 0 &&
    Number.isFinite(samples) &&
    samples > 0 &&
    Number.isFinite(headroom) &&
    headroom > 0 &&
    since < samples;
  return { inGrace, effWaterMb: base + (inGrace ? headroom : 0) };
}

module.exports = { effectiveWaterMb, GRACE_SAMPLES_DEFAULT, GRACE_HEADROOM_MB_DEFAULT };

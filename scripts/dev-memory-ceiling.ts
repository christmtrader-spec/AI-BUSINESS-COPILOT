/**
 * dev-memory-ceiling.ts — R180: the ONE source for the Turbopack engine's
 * memory ceiling (R179 §3 priority #2: "route-cache lean work for the
 * OOM-band" — this is the honest lever the installed Next actually ships).
 *
 * THE EVIDENCE CHAIN (banked, install-pinned — no docs-from-memory):
 *   - Next 16.1.3's own source comment (config-shared.ts, restored from the
 *     shipped .map): "A target memory limit for turbo, in bytes."
 *   - The DEV path consumes it: node_modules/next/dist/server/dev/
 *     hot-reloader-turbopack.js passes
 *     `memoryLimit: opts.nextConfig.experimental?.turbopackMemoryLimit`
 *     into `bindings.turbo.createProject(..., { persistentCaching,
 *     memoryLimit, isShortSession: false })`.
 *   - The BUILD path consumes it too: node_modules/next/dist/build/
 *     turbopack-build/impl.js (same key into the same binding call).
 *   - The battery (r180-memory-ceiling-check.ts) re-verifies BOTH facts
 *     against the INSTALLED files at run time — a Next upgrade that drops
 *     or renames the key turns the suite RED, not the runtime silent.
 *
 * WHY A SOFT CEILING (the layered-defense story):
 *   - The sandbox disease (R178/R179): next-server RSS fattens over hours
 *     (settle 2290-2406MB, transient peaks 2731-2771MB) and the KERNEL OOM
 *     killer has shot it at ~1.7-2.2GB anon-rss during compile storms —
 *     BELOW the guard's 2600MB recycle water, so the kernel fires first
 *     and the chain can only recover (~2s), never prevent.
 *   - The kernel kill is CGROUP-global (it picks the fattest process when
 *     the sandbox memory pool exhausts during PASS storms — next-server,
 *     chrome and the battery runners compete). Shrinking next-server's
 *     peak frees cgroup headroom for the whole chain.
 *   - The engine ceiling is the ONLY in-process lever that acts BEFORE the
 *     external layers: when the tracked engine allocations reach the limit,
 *     the Turbopack engine drops caches and collects (a soft target, not a
 *     hard cap) — recompiles on eviction are the honest cost, recycled
 *     servers and kernel kills are the alternative.
 *
 * THE LAYERED DEFENSE (post-R180):
 *   1. ENGINE CEILING (this module, 2048MiB default) — collects first.
 *   2. GUARD RECYCLE (dev-rss-guard.cjs HIGH_WATER_MB 2600 × CONSECUTIVE 3)
 *      — unchanged law; acts on whole-process RSS the engine can't shed.
 *   3. KERNEL OOM — the last resort this round engineers AWAY from.
 *
 * THE VALUE (2048MiB, evidence-based, not vibes):
 *   - At/below the kernel kill band's top (~2.2GB) so the engine's collect
 *     fires BEFORE the kernel's aim is true; whole-process worst case
 *     (engine 2048 + V8 ~400 + native ~200) stays under the guard's 2600
 *     recycle water — the ceiling acts first by construction.
 *   - Above the documented settle band's engine share, so steady-state dev
 *     does NOT thrash: eviction only bites the fat peaks (the disease),
 *     never the normal working set.
 *   - Env-overridable: NEXT_TURBOPACK_MEMORY_MB (MB, human-ergonomic — the
 *     config layer converts to bytes; the 1536-bytes unit bug class is
 *     fenced by the MB floor below and pinned by the battery).
 *
 * UNIT LAW (the classic bug this module exists to prevent):
 *   - INPUT unit is MB; OUTPUT unit is BYTES (Next's own comment is the
 *     ground truth). 2048 (a bare MB-looking number) as BYTES would be a
 *     2048-byte ceiling — an absurd instant-thrash; the MB floor (256)
 *     turns that class of typo into a loud throw instead of a silent
 *     crippled dev server.
 */

/** The engine ceiling's default, in MB (converted to bytes at the boundary). */
export const DEFAULT_TURBOPACK_MEMORY_MB = 2048;

/** Hard floor in MB: anything below is a unit bug (bytes passed as MB), not a tune. */
export const MIN_TURBOPACK_MEMORY_MB = 256;

/** The env knob's name — the ops contract, pinned by the battery. */
export const TURBOPACK_MEMORY_ENV = "NEXT_TURBOPACK_MEMORY_MB";

const MB_TO_BYTES = 1024 * 1024;

/**
 * The Turbopack engine memory ceiling in BYTES — the exact shape
 * `experimental.turbopackMemoryLimit` wants (Next's own comment: "in
 * bytes"). Reads the env knob every call (no module-level caching) so a
 * battery can flip the env per-case and observe the conversion live.
 */
export function turbopackMemoryCeilingBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[TURBOPACK_MEMORY_ENV];
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TURBOPACK_MEMORY_MB;
  if (mb < MIN_TURBOPACK_MEMORY_MB) {
    throw new Error(
      `${TURBOPACK_MEMORY_ENV}=${raw} is below the ${MIN_TURBOPACK_MEMORY_MB}MB floor — ` +
        "the input unit is MB (the config layer converts to bytes); a smaller value is a unit bug."
    );
  }
  return Math.floor(mb) * MB_TO_BYTES;
}

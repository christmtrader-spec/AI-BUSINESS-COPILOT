/**
 * ChunkLoadError self-recovery.
 *
 * Dev servers (Turbopack) occasionally rotate chunk hashes — a browser tab
 * holding an older page then fails with "Failed to load chunk …" and the
 * only real cure is a full reload (reset() just re-renders a dead module
 * graph). These helpers let the route/root error boundaries detect that
 * case and hard-reload ONCE (sessionStorage-guarded so a genuinely broken
 * build can't trap the user in a reload loop).
 */

const RECOVERY_KEY = "copilot:chunk-recovery-at";
/** Reload attempts within this window are suppressed (loop guard). */
const RECOVERY_WINDOW_MS = 15_000;

/** Next.js (webpack + Turbopack) chunk-failure signatures. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  const msg = typeof message === "string" ? message : "";
  return (
    name === "ChunkLoadError" ||
    /Failed to load chunk|Loading chunk [\s\S]+ failed|dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      msg,
    )
  );
}

/**
 * Hard-reload the page at most once per RECOVERY_WINDOW_MS.
 * Returns true when a reload was initiated (the caller should render a
 * transient "updating" state instead of the full error UI).
 */
export function hardReloadOnce(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RECOVERY_KEY) ?? 0);
    if (!Number.isFinite(last) || last <= 0) last = 0;
  } catch {
    // Storage unavailable (privacy mode) — treat as "never reloaded".
    last = 0;
  }

  if (last > 0 && Date.now() - last < RECOVERY_WINDOW_MS) {
    return false; // Already tried recently — stay on the manual-recovery UI.
  }

  try {
    sessionStorage.setItem(RECOVERY_KEY, String(Date.now()));
  } catch {
    // Storage writes blocked; still safe to reload once.
  }

  // location.reload() preserves the URL including hash-based views
  // (#/reset-password/<token>, #/join/<token>), so deep links survive.
  window.location.reload();
  return true;
}

"use client";

import { useEffect } from "react";

/**
 * ChunkLoadError self-healing.
 *
 * In dev (Turbopack HMR) and after production redeploys, a long-lived browser
 * tab can reference JS chunks that no longer exist on the server (hash
 * changed). The user then sees "Failed to load chunk ./_next/static/chunks/…"
 * when a lazily-loaded module (e.g. the settings views) opens.
 *
 * Recovery: detect the failure globally and hard-reload ONCE so the tab picks
 * up the current build's HTML + chunk manifest. A sessionStorage timestamp
 * guards against reload loops (if the fresh build is also broken, we stop).
 *
 * Mounted once in the root layout; renders nothing.
 */
const RELOAD_GUARD_KEY = "chunk-recovery:last-reload-at";
const RELOAD_MIN_INTERVAL_MS = 8_000;

function isChunkLoadFailure(message: string): boolean {
  return (
    message.includes("ChunkLoadError") ||
    message.includes("Failed to load chunk") ||
    message.includes("Loading chunk") ||
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("Importing a module script failed")
  );
}

function recoverOnce(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    const now = Date.now();
    if (Number.isFinite(last) && now - last < RELOAD_MIN_INTERVAL_MS) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
  } catch {
    // sessionStorage unavailable (privacy mode) — still attempt one reload;
    // without the guard a loop is possible, but a broken app is worse.
  }
  window.location.reload();
}

export function ChunkRecovery() {
  useEffect(() => {
    // 1) Runtime ChunkLoadError (thrown by the bundler runtime → ErrorEvent)
    //    and failed dynamic import() rejections.
    const onError = (event: ErrorEvent) => {
      const message = event.error?.message ?? event.message ?? "";
      if (isChunkLoadFailure(message)) recoverOnce();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "";
      if (isChunkLoadFailure(message)) recoverOnce();
    };

    // 2) <script src="/_next/..."> that never finished loading arrives as a
    //    resource error (no Error object) — detect via the event target.
    const onResourceError = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLScriptElement &&
        typeof target.src === "string" &&
        target.src.includes("/_next/")
      ) {
        recoverOnce();
      }
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    // Resource errors don't bubble; capture phase is required.
    window.addEventListener("error", onResourceError, true);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onResourceError, true);
    };
  }, []);

  return null;
}

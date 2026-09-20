"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hardReloadOnce, isChunkLoadError } from "@/lib/chunk-recovery";

/**
 * Route-level error boundary (Phase 06 hardening, r19 chunk-recovery).
 * Catches anything that escapes module boundaries (e.g. a provider crash)
 * and offers a recoverable way back in. Bilingual by construction: the
 * route tree renders outside the app shell's locale context.
 *
 * Stale-chunk case: if the failure is a ChunkLoadError (dev server rotated
 * chunk hashes, or a deploy replaced the bundle under the tab), a plain
 * reset() re-renders a dead module graph — a full reload is the cure, so
 * the boundary auto-reloads once and shows a transient "updating" state.
 */
export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [recovering, setRecovering] = useState(false);
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    console.error("[RouteError]", error);
    if (!chunkError || !hardReloadOnce()) return;
    // Defer the UI swap out of the synchronous effect body — the reload
    // itself lands within the same tick sequence anyway.
    const t = setTimeout(() => setRecovering(true), 0);
    return () => clearTimeout(t);
  }, [error, chunkError]);

  if (recovering) {
    return (
      <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
        <Loader2 className="text-muted-foreground size-8 animate-spin" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            Updating the application…
            <span className="text-muted-foreground mx-2 font-normal" dir="rtl">
              · در حال به‌روزرسانی برنامه…
            </span>
          </h1>
          <p className="text-muted-foreground text-sm">
            A newer version was detected — reloading.
            <span dir="rtl" className="block">
              نسخه جدیدی شناسایی شد — در حال بارگیری دوباره.
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-full">
        <AlertTriangle className="size-7" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Something went wrong
          <span className="text-muted-foreground mx-2 font-normal" dir="rtl">
            · خطایی رخ داد
          </span>
        </h1>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">
          {chunkError
            ? "A stale application bundle was detected. Reload the page to continue — your saved data is safe on the server."
            : "The application hit an unexpected error. You can retry — your saved data is safe on the server."}
          <span dir="rtl" className="block">
            {chunkError
              ? "نسخه قدیمی از برنامه شناسایی شد. برای ادامه صفحه را دوباره بارگیری کنید؛ داده‌های شما روی سرور امن است."
              : "خطای غیرمنتظره‌ای پیش آمد. می‌توانید دوباره تلاش کنید؛ داده‌های شما روی سرور امن است."}
          </span>
        </p>
        {error.digest ? (
          <p className="text-muted-foreground/70 font-mono text-[11px]">
            digest: {error.digest}
          </p>
        ) : null}
      </div>
      {/* Chunk errors cannot be healed by reset() — force a full reload. */}
      <Button
        onClick={() => {
          if (chunkError) {
            window.location.reload();
            return;
          }
          reset();
        }}
      >
        <RotateCcw className="size-4" aria-hidden="true" />
        {chunkError ? "Reload page" : "Try again"}
        <span dir="rtl" className="ms-1">
          {chunkError ? "· بارگیری دوباره صفحه" : "· تلاش دوباره"}
        </span>
      </Button>
    </div>
  );
}

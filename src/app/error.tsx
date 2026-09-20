"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary (Phase 06 hardening).
 * Catches anything that escapes module boundaries (e.g. a provider crash)
 * and offers a recoverable way back in. Bilingual by construction: the
 * route tree renders outside the app shell's locale context.
 */
export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[RouteError]", error);
  }, [error]);

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
          The application hit an unexpected error. You can retry — your saved
          data is safe on the server.
          <span dir="rtl" className="block">
            خطای غیرمنتظره‌ای پیش آمد. می‌توانید دوباره تلاش کنید؛ داده‌های شما
            روی سرور امن است.
          </span>
        </p>
        {error.digest ? (
          <p className="text-muted-foreground/70 font-mono text-[11px]">
            digest: {error.digest}
          </p>
        ) : null}
      </div>
      <Button onClick={reset}>
        <RotateCcw className="size-4" aria-hidden="true" />
        Try again
        <span dir="rtl" className="ms-1">
          · تلاش دوباره
        </span>
      </Button>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { hardReloadOnce, isChunkLoadError } from "@/lib/chunk-recovery";

/**
 * Root-level error boundary — last resort when the root layout itself
 * crashes. Renders its own <html>/<body> per Next.js requirements.
 * Bilingual by construction (EN + FA) like src/app/error.tsx.
 *
 * Stale-chunk case: auto hard-reload once (sessionStorage-guarded) since
 * reset() cannot resurrect a rotated chunk hash (r19 chunk-recovery).
 */
export default function GlobalRootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [recovering, setRecovering] = useState(false);
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    if (typeof console !== "undefined") console.error("[RootError]", error);
    if (!chunkError || !hardReloadOnce()) return;
    // Defer the UI swap out of the synchronous effect body (lint-clean);
    // the reload itself lands within the same tick sequence anyway.
    const t = setTimeout(() => setRecovering(true), 0);
    return () => clearTimeout(t);
  }, [error, chunkError]);

  if (recovering) {
    return (
      <html lang="en" dir="ltr" suppressHydrationWarning>
        <body
          style={{
            fontFamily: "system-ui, sans-serif",
            background: "#fafafa",
            color: "#18181b",
            minHeight: "100svh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            textAlign: "center",
            margin: 0,
          }}
        >
          <div style={{ display: "grid", gap: "0.75rem", justifyItems: "center" }}>
            <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
              Updating the application…
              <span dir="rtl" style={{ fontWeight: 400, marginInlineStart: "0.5rem" }}>
                · در حال به‌روزرسانی برنامه…
              </span>
            </h1>
            <p style={{ color: "#71717a", margin: 0, fontSize: "0.875rem" }}>
              A newer version was detected — reloading.
              <span dir="rtl" style={{ display: "block" }}>
                نسخه جدیدی شناسایی شد — در حال بارگیری دوباره.
              </span>
            </p>
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          background: "#fafafa",
          color: "#18181b",
          minHeight: "100svh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          textAlign: "center",
          gap: "1.25rem",
          margin: 0,
        }}
      >
        <div style={{ display: "grid", gap: "1rem", justifyItems: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
            Something went wrong
            <span dir="rtl" style={{ fontWeight: 400, marginInlineStart: "0.5rem" }}>
              · خطایی رخ داد
            </span>
          </h1>
          <p style={{ color: "#71717a", maxWidth: "28rem", margin: 0, fontSize: "0.875rem" }}>
            {chunkError
              ? "A stale application bundle was detected. Reload the page to continue — your saved data is safe on the server."
              : "The application hit an unexpected error. Your saved data is safe on the server."}
            <span dir="rtl" style={{ display: "block" }}>
              {chunkError
                ? "نسخه قدیمی از برنامه شناسایی شد. برای ادامه صفحه را دوباره بارگیری کنید؛ داده‌های شما روی سرور امن است."
                : "خطای غیرمنتظره‌ای پیش آمد؛ داده‌های شما روی سرور امن است."}
            </span>
          </p>
          <button
            onClick={() => {
              if (chunkError) {
                window.location.reload();
                return;
              }
              reset();
            }}
            style={{
              background: "#18181b",
              color: "#fafafa",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            {chunkError ? "Reload page" : "Try again"} ·{" "}
            <span dir="rtl">{chunkError ? "بارگیری دوباره صفحه" : "تلاش دوباره"}</span>
          </button>
          {error.digest ? (
            <code style={{ fontSize: "0.6875rem", color: "#a1a1aa" }}>
              digest: {error.digest}
            </code>
          ) : null}
        </div>
      </body>
    </html>
  );
}

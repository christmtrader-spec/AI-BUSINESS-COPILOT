"use client";

/**
 * Root-level error boundary — last resort when the root layout itself
 * crashes. Renders its own <html>/<body> per Next.js requirements.
 * Bilingual by construction (EN + FA) like src/app/error.tsx.
 */
export default function GlobalRootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
            The application hit an unexpected error. Your saved data is safe on
            the server.
            <span dir="rtl" style={{ display: "block" }}>
              خطای غیرمنتظره‌ای پیش آمد؛ داده‌های شما روی سرور امن است.
            </span>
          </p>
          <button
            onClick={reset}
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
            Try again · <span dir="rtl">تلاش دوباره</span>
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

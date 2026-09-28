/**
 * Next.js instrumentation entry — Prompt 29 §6/§70/§71.
 *
 * Thin runtime selector: the actual logic (startup validation + graceful
 * shutdown) lives in instrumentation-node.ts and is imported ONLY for the
 * nodejs runtime, so the Edge bundle never sees Node-only APIs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}

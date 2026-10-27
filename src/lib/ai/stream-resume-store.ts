/**
 * R126 — the SHARED stream-resume singleton.
 *
 * The stream route, the resume route, and the stop route are separate
 * Next.js route modules; they MUST address the same in-memory buffer, so
 * the registry lives here (one instance per server process — single-node
 * SQLite deployment, the same assumption the rate limiter makes).
 *
 * Bounds: 100 entries, 64KB per answer, 120s live TTL, 30s after the stream
 * finished. A transport aid, never storage: nothing here survives a server
 * restart, and the client's fallback on RESUME_NOT_FOUND is the honest
 * partial-answer handling that existed before R126.
 */
import { createStreamResumeRegistry } from "./stream-resume";

export const streamResumeStore = createStreamResumeRegistry({
  now: () => Date.now(),
});

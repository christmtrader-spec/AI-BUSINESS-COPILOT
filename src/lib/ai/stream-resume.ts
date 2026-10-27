/**
 * R126 — Stream resume registry: the server-side memory behind post-delta
 * resume (the last big transport item from R121 ③ / R125 ①).
 *
 * The problem it solves: the copilot's SSE answer streams through one HTTP
 * connection. When that connection dies MID-ANSWER (network blip, laptop
 * sleep, proxy timeout), today the client keeps the partial text and appends
 * a failure note — the answer is truncated forever, even though the model
 * was still generating. With this registry the stream route keeps consuming
 * the provider into a bounded in-memory buffer after the client vanishes
 * (the charge already stands per Prompt 21 §45 — at least one delta was
 * delivered), and the client re-attaches with POST /copilot/stream/resume
 * to pick up exactly the deltas it has not seen yet.
 *
 * LAWS (battery-pinned in scripts/r126-stream-resume-check.ts):
 * - BOUNDED: maxEntries entries (oldest evicted, insertion order), a hard
 *   per-entry character cap (overflow flagged, never grows unbounded), a
 *   TTL from creation, and a shorter TTL once the stream finished — an
 *   entry is a short-lived transport aid, not storage.
 * - AUTHZ INSIDE: snapshot() and markUserStopped() take the caller's
 *   businessId + userId and return null/false on ANY mismatch — the HTTP
 *   endpoints re-check too, but the pure core never trusts its caller.
 * - KEEP-ORIGINAL: a re-register of a live requestId is refused (the
 *   original buffer must never be forked — a client retry with the same
 *   Prompt 21 idempotency key attaches to the SAME answer).
 * - PURITY: time is injected (no Date.now), nothing mutates caller inputs,
 *   snapshot returns fresh arrays.
 */

export interface StreamResumeError {
  code: string;
  message?: string;
}

export interface StreamResumeSnapshot {
  /** Deltas the caller has NOT seen yet, oldest first. */
  deltas: string[];
  /** Total deltas the buffer holds AFTER this snapshot (the caller's next fromIndex). */
  nextIndex: number;
  /** The original stream reached its normal end. */
  done: boolean;
  /** The original stream failed mid-answer (AI unavailable, internal error). */
  error: StreamResumeError | null;
  /** The user pressed Stop (the client never sees this; defensive finalization). */
  stopped: boolean;
  /**
   * The buffer hit its per-entry character cap: deltas the live client
   * received were dropped from the buffer, so a replay from an earlier
   * fromIndex would have a MIDDLE GAP. The client must finalize with its
   * partial text instead of resuming whenever this is true and deltas
   * would be applied.
   */
  overflow: boolean;
}

interface RegistryOptions {
  now: () => number;
  /** Entries older than this (ms since creation) are swept. Default 120s. */
  ttlMs?: number;
  /** Finished entries (done | error | stopped) expire after this. Default 30s. */
  finishedTtlMs?: number;
  /** Maximum simultaneous entries; oldest is evicted when full. Default 100. */
  maxEntries?: number;
  /** Maximum buffered characters per answer; beyond this the entry overflows. Default 64_000. */
  maxCharsPerEntry?: number;
}

interface ResumeEntry {
  businessId: string;
  userId: string;
  deltas: string[];
  chars: number;
  overflow: boolean;
  done: boolean;
  error: StreamResumeError | null;
  stopped: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StreamResumeRegistry {
  register(requestId: string, owner: { businessId: string; userId: string }): boolean;
  appendDelta(requestId: string, delta: string): boolean;
  finish(requestId: string): void;
  fail(requestId: string, error: StreamResumeError): void;
  markUserStopped(
    requestId: string,
    owner: { businessId: string; userId: string },
  ): boolean;
  snapshot(
    requestId: string,
    fromIndex: number,
    owner: { businessId: string; userId: string },
  ): StreamResumeSnapshot | null;
  isStopped(requestId: string, owner: { businessId: string; userId: string }): boolean;
  drop(requestId: string): void;
  size(): number;
}

export function createStreamResumeRegistry(options: RegistryOptions): StreamResumeRegistry {
  const now = options.now;
  const ttlMs = options.ttlMs ?? 120_000;
  const finishedTtlMs = options.finishedTtlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 100;
  const maxCharsPerEntry = options.maxCharsPerEntry ?? 64_000;

  const entries = new Map<string, ResumeEntry>();

  const finished = (e: ResumeEntry): boolean => e.done || e.error !== null || e.stopped;

  /** Lazy sweep — called on every mutation/read; the map stays tiny. */
  const sweep = (): void => {
    const t = now();
    for (const [id, e] of entries) {
      const age = t - e.createdAt;
      const limit = finished(e) ? finishedTtlMs : ttlMs;
      if (age > limit) entries.delete(id);
    }
  };

  /** Evict the OLDEST entry (Map preserves insertion order) when over cap. */
  const evictOldestIfFull = (): void => {
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };

  const owned = (
    e: ResumeEntry | undefined,
    owner: { businessId: string; userId: string },
  ): e is ResumeEntry => e !== undefined && e.businessId === owner.businessId && e.userId === owner.userId;

  return {
    register(requestId, owner) {
      sweep();
      const existing = entries.get(requestId);
      // KEEP-ORIGINAL: a live entry with the same id stays the single buffer
      // for this logical answer (Prompt 21 idempotency key on the transport).
      if (existing) return false;
      evictOldestIfFull();
      const t = now();
      entries.set(requestId, {
        businessId: owner.businessId,
        userId: owner.userId,
        deltas: [],
        chars: 0,
        overflow: false,
        done: false,
        error: null,
        stopped: false,
        createdAt: t,
        updatedAt: t,
      });
      return true;
    },

    appendDelta(requestId, delta) {
      sweep();
      const e = entries.get(requestId);
      if (!e || e.done || e.error || e.stopped) return false;
      if (e.chars + delta.length > maxCharsPerEntry) {
        // Hard cap: the buffer refuses further growth but the entry stays
        // resumable up to what it holds; the flag tells the client this
        // answer is too large to guarantee a complete replay.
        e.overflow = true;
        return false;
      }
      e.deltas.push(delta);
      e.chars += delta.length;
      e.updatedAt = now();
      return true;
    },

    finish(requestId) {
      const e = entries.get(requestId);
      if (!e) return;
      e.done = true;
      e.updatedAt = now();
    },

    fail(requestId, error) {
      const e = entries.get(requestId);
      if (!e || e.done) return;
      e.error = { code: error.code, ...(error.message ? { message: error.message } : {}) };
      e.updatedAt = now();
    },

    markUserStopped(requestId, owner) {
      sweep();
      const e = entries.get(requestId);
      if (!owned(e, owner)) return false;
      if (e.done || e.error) return false;
      e.stopped = true;
      e.updatedAt = now();
      return true;
    },

    snapshot(requestId, fromIndex, owner) {
      sweep();
      const e = entries.get(requestId);
      if (!owned(e, owner)) return null;
      const index = Math.max(0, Math.min(Math.floor(fromIndex), e.deltas.length));
      return {
        deltas: e.deltas.slice(index),
        nextIndex: e.deltas.length,
        done: e.done,
        error: e.error ? { ...e.error } : null,
        stopped: e.stopped,
        overflow: e.overflow,
      };
    },

    drop(requestId) {
      entries.delete(requestId);
    },

    /**
     * O(1) stop-flag peek for the stream route's per-delta check — NO sweep
     * (a Map lookup per delta must stay allocation-free; expiry is enforced
     * by the swept readers).
     */
    isStopped(requestId, owner) {
      const e = entries.get(requestId);
      return owned(e, owner) ? e.stopped : false;
    },

    size() {
      sweep();
      return entries.size;
    },
  };
}

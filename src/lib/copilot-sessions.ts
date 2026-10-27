/**
 * Copilot conversation persistence (client-side, Phase 06+ UX).
 *
 * Conversations are stored in localStorage PER BUSINESS so switching
 * businesses (or reloading) never loses a transcript. This is UI state,
 * NOT financial authority: every figure inside an answer is recomputed
 * by the server on each ask (A11-A13) — stored answers are historical
 * narration only, and the citation chips carry their own provenance.
 *
 * Keyed by business id so one browser can hold transcripts for several
 * businesses without cross-tenant leakage (defense in depth — the API
 * itself is the real tenant boundary).
 */

export type StoredCopilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  failed?: boolean;
  /** R127 — set ONLY when an answer was restored through the stream-resume
   *  healing path (R126): the client's own stream was cut mid-answer and the
   *  bounded server buffer completed it. A server-transcript restore (other
   *  device / reload) never carries the marker — it must not inflate the
   *  transport-reliability numerator (R128 law C). */
  healed?: boolean;
  /** Citation provenance (server-computed) — kept so restored answers
   *  still show WHERE their numbers came from. */
  meta?: unknown;
};

export type CopilotSession = {
  id: string;
  /** Auto-title: first user question, truncated. */
  title: string;
  /** User renamed the conversation — the auto-title must never override it. */
  titleEdited?: boolean;
  /** Pinned conversations sort first in the history list. */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: StoredCopilotMessage[];
};

export type StoredCopilotState = {
  sessions: CopilotSession[];
  activeId: string | null;
};

export const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 200;
const KEY_PREFIX = "abc:copilot:sessions:v1:";

function storageKey(businessId: string): string {
  return `${KEY_PREFIX}${businessId}`;
}

/** Collision-proof message id (restored sessions share the old seq space). */
export function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `m-${crypto.randomUUID().slice(0, 13)}`;
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `s-${crypto.randomUUID().slice(0, 13)}`;
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptySession(title = ""): CopilotSession {
  const now = Date.now();
  return { id: newSessionId(), title, createdAt: now, updatedAt: now, messages: [] };
}

/** Auto-title from the first user question (trimmed, ≤ 48 chars). */
export function titleFromQuestion(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

function sanitizeSession(raw: unknown): CopilotSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<CopilotSession>;
  if (typeof s.id !== "string" || s.id.length === 0) return null;
  if (!Array.isArray(s.messages)) return null;
  const messages: StoredCopilotMessage[] = s.messages
    .filter(
      (m): m is StoredCopilotMessage =>
        !!m &&
        typeof m === "object" &&
        typeof (m as StoredCopilotMessage).id === "string" &&
        ((m as StoredCopilotMessage).role === "user" ||
          (m as StoredCopilotMessage).role === "assistant") &&
        typeof (m as StoredCopilotMessage).content === "string",
    )
    .slice(-MAX_MESSAGES_PER_SESSION)
    .map((m) => ({ id: m.id, role: m.role, content: m.content, ...(m.failed ? { failed: true } : {}), ...(m.healed === true ? { healed: true } : {}), ...(m.meta ? { meta: m.meta } : {}) }));
  const createdAt = typeof s.createdAt === "number" ? s.createdAt : Date.now();
  const updatedAt = typeof s.updatedAt === "number" ? s.updatedAt : createdAt;
  const title = typeof s.title === "string" ? s.title.slice(0, 80) : "";
  return {
    id: s.id,
    title,
    ...(s.titleEdited ? { titleEdited: true } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    createdAt,
    updatedAt,
    messages,
  };
}

/** Load + validate the stored state for a business (never throws). */
export function loadCopilotState(businessId: string): StoredCopilotState {
  const empty: StoredCopilotState = { sessions: [], activeId: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(storageKey(businessId));
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;
    const state = parsed as Partial<StoredCopilotState>;
    if (!Array.isArray(state.sessions)) return empty;
    const sessions = state.sessions
      .map(sanitizeSession)
      .filter((s): s is CopilotSession => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false))
      .slice(0, MAX_SESSIONS);
    const activeId =
      typeof state.activeId === "string" && sessions.some((s) => s.id === state.activeId)
        ? state.activeId
        : (sessions[0]?.id ?? null);
    return { sessions, activeId };
  } catch {
    return empty;
  }
}

/** Persist the state (prunes oldest sessions; never throws). Pinned
 *  sessions are protected from pruning while their count leaves room. */
export function saveCopilotState(businessId: string, state: StoredCopilotState): void {
  if (typeof window === "undefined") return;
  try {
    const sessions = state.sessions
      .filter((s) => s.messages.length > 0 || s.id === state.activeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false))
      .slice(0, MAX_SESSIONS);
    const activeId =
      state.activeId && sessions.some((s) => s.id === state.activeId)
        ? state.activeId
        : (sessions[0]?.id ?? null);
    window.localStorage.setItem(
      storageKey(businessId),
      JSON.stringify({ sessions, activeId } satisfies StoredCopilotState),
    );
  } catch {
    // Quota exceeded / storage unavailable — transcripts are best-effort UX,
    // never critical data. Silently skip.
  }
}

/**
 * R128 — device-local transport-reliability fact (PURE — no DOM, no IO,
 * inputs never mutated, fresh result object every call).
 *
 * The insights panel's quiet line is built from this fraction:
 *   answered = healthy assistant answers (role=assistant · not failed ·
 *              non-empty content) — user messages, failed answers and
 *              empty/whitespace-only answers sit OUTSIDE the fraction.
 *   healed   = the subset whose answer came through the R126 stream-resume
 *              healing path (the R127 `healed` marker). A server-restored
 *              answer inflates the denominator only (law C).
 *
 * Defensive by design (law F): null sessions, missing/undefined message
 * arrays and malformed messages never crash — the sanitizer guarantees
 * shape on load, but the core must not assume it.
 */
export type TransportReliability = {
  /** Healthy assistant answers (the denominator). */
  answered: number;
  /** Answers recovered via stream-resume healing (the numerator). */
  healed: number;
};

export function transportReliability(sessions: CopilotSession[]): TransportReliability {
  let answered = 0;
  let healed = 0;
  const list = Array.isArray(sessions) ? sessions : [];
  for (const s of list) {
    if (!s || typeof s !== "object" || !Array.isArray(s.messages)) continue;
    for (const m of s.messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role !== "assistant") continue;
      if (m.failed === true) continue;
      if (typeof m.content !== "string" || m.content.trim().length === 0) continue;
      answered += 1;
      if (m.healed === true) healed += 1;
    }
  }
  return { answered, healed };
}

/** Remove ALL stored transcripts for a business (used by "clear history"). */
export function clearCopilotState(businessId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(businessId));
  } catch {
    // ignore
  }
}

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
    .map((m) => ({ id: m.id, role: m.role, content: m.content, ...(m.failed ? { failed: true } : {}), ...(m.meta ? { meta: m.meta } : {}) }));
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

/** Remove ALL stored transcripts for a business (used by "clear history"). */
export function clearCopilotState(businessId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(businessId));
  } catch {
    // ignore
  }
}

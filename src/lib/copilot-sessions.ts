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
  /** R138 — creation stamp (epoch ms, LOCAL clock). Set by this device at
   *  append time; a server-transcript restore maps the server row's
   *  createdAt onto it (copilot-sync). OPTIONAL additive law: older
   *  persisted messages honestly omit it — the transcript renders their
   *  bubbles without a time label and never fabricates one. */
  ts?: number;
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
    .map((m) => ({ id: m.id, role: m.role, content: m.content, ...(typeof m.ts === "number" && Number.isFinite(m.ts) ? { ts: m.ts } : {}), ...(m.failed ? { failed: true } : {}), ...(m.healed === true ? { healed: true } : {}), ...(m.meta ? { meta: m.meta } : {}) }));
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

// ---- R138 transcript-time helpers (PURE — no DOM, no IO) -------------------

/**
 * Local calendar-day key of an epoch-ms stamp ("YYYY-MM-DD" in the device's
 * own timezone — the transcript groups by the day the READER experienced,
 * never UTC). Defensive: a non-finite stamp yields an empty key so callers
 * can detect "no honest day" and skip the separator (additive law — old
 * messages without ts never fabricate one).
 */
export function dayKeyLocal(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Which separator label a stamp deserves relative to `now`: today, yesterday,
 * or an absolute calendar date (the view formats it through Intl so the FA
 * surface gets the Jalali calendar + Persian digits automatically).
 * Defensive (law F): malformed stamps fall through to the honest "date" kind
 * only when finite — otherwise the caller renders nothing.
 */
export type DaySeparator =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; ts: number };

export function daySeparatorFor(ts: number, now: number = Date.now()): DaySeparator | null {
  const key = dayKeyLocal(ts);
  if (key === "") return null;
  const nowKey = dayKeyLocal(now);
  if (key === nowKey) return { kind: "today" };
  const yesterdayKey = dayKeyLocal(now - 86_400_000);
  // Direct key comparison — NOT a raw 24h subtraction, so a message from
  // 23:59 yesterday still reads "yesterday" at 00:01 today (DST-day drift
  // collapses to at most one mislabeled hour, never a wrong calendar claim).
  if (key === yesterdayKey) return { kind: "yesterday" };
  return { kind: "date", ts };
}

/**
 * R138 — session history search (PURE). A conversation matches when the
 * query appears in its title OR any message's content (case-insensitive,
 * locale-aware lowercasing — Persian text compares verbatim). A blank
 * query matches everything (the unfiltered list). Defensive by design:
 * null sessions, missing titles and malformed message arrays never crash.
 */
export function sessionMatchesQuery(
  session: { title?: string; messages?: Array<{ content?: unknown }> } | null | undefined,
  query: string,
): boolean {
  const q = (typeof query === "string" ? query : "").trim().toLocaleLowerCase();
  if (q.length === 0) return true;
  if (!session || typeof session !== "object") return false;
  const title = typeof session.title === "string" ? session.title.toLocaleLowerCase() : "";
  if (title.includes(q)) return true;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = typeof m.content === "string" ? m.content.toLocaleLowerCase() : "";
    if (content.includes(q)) return true;
  }
  return false;
}

/**
 * R141 — session-search match geometry (PURE). Where does the query hit?
 *
 * The history dropdown's search (R138) matches TITLE OR CONTENT, but the
 * row only showed the title — a content match was invisible ("why is this
 * here?"). sessionMatchParts answers honestly:
 *  - titleMark*: the FIRST title occurrence's [start, end) (-1 when the
 *    title does not match);
 *  - preview: a ONE-LINE window of the FIRST content-matching message,
 *    cut around the match with honest ellipses on every cut edge, plus
 *    the match's [start, end) offsets WITHIN the window slice;
 *  - everything null/-1/false when the query is blank or the session is
 *    malformed — the caller then renders the plain row (no fabricated
 *    highlights).
 *
 * The matching itself mirrors sessionMatchesQuery exactly (trim +
 * toLocaleLowerCase on BOTH sides — locale-aware, Persian compares
 * verbatim), so a row can never highlight something the filter did not
 * match. Defensive by design (law F): null sessions, non-string titles
 * and malformed message arrays never crash.
 */
export type SessionMatchParts = {
  /** Title contains the query (first occurrence marked in the view). */
  titleMarkStart: number;
  titleMarkEnd: number;
  /** Windowed content preview (null when no message content matches). */
  preview: string | null;
  /** The match's offsets INSIDE the preview window (-1 when no preview). */
  previewMarkStart: number;
  previewMarkEnd: number;
  /** R142 — how MANY messages match the query in total (0 when none, 1
   *  when only the previewed one). The preview shows the FIRST match; the
   *  view renders an honest +{matchCount-1} badge when more hide behind
   *  it — the count never lies about what the row does not show. */
  matchCount: number;
};

/** Radius of context shown around a content match (chars, one line). */
const MATCH_PREVIEW_CONTEXT = 28;

export function sessionMatchParts(
  session: { title?: string; messages?: Array<{ content?: unknown }> } | null | undefined,
  query: string,
): SessionMatchParts {
  const blank: SessionMatchParts = {
    titleMarkStart: -1,
    titleMarkEnd: -1,
    preview: null,
    previewMarkStart: -1,
    previewMarkEnd: -1,
    matchCount: 0,
  };
  const q = (typeof query === "string" ? query : "").trim().toLocaleLowerCase();
  if (q.length === 0 || !session || typeof session !== "object") return blank;

  // Title: first occurrence of the lowered query in the lowered title.
  // Offsets are computed on the LOWERED string and reused on the ORIGINAL
  // — honest constraint: for the supported UI locales (en, fa) 
  // toLocaleLowerCase is length-preserving, so lowered offsets map 1:1
  // onto the original string.
  const titleOriginal = typeof session.title === "string" ? session.title : "";
  const titleMarkStart = titleOriginal.toLocaleLowerCase().indexOf(q);
  const titleMarkEnd = titleMarkStart >= 0 ? titleMarkStart + q.length : -1;

  // Content: EVERY message whose lowered content contains the query (the
  // count is honest over ALL messages); the preview windows the FIRST one.
  const messages = Array.isArray(session.messages) ? session.messages : [];
  let matchCount = 0;
  let first: SessionMatchParts | null = null;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length === 0) continue;
    const idx = content.toLocaleLowerCase().indexOf(q);
    if (idx < 0) continue;
    matchCount += 1;
    if (first !== null) continue; // the first match already owns the preview
    // Window the ORIGINAL text around the match (context on both sides,
    // honest ellipses only on actual cut edges).
    const start = Math.max(0, idx - MATCH_PREVIEW_CONTEXT);
    const end = Math.min(content.length, idx + q.length + MATCH_PREVIEW_CONTEXT);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < content.length ? "…" : "";
    const window = `${prefix}${content.slice(start, end)}${suffix}`;
    first = {
      titleMarkStart,
      titleMarkEnd,
      preview: window,
      previewMarkStart: prefix.length + (idx - start),
      previewMarkEnd: prefix.length + (idx - start) + q.length,
      matchCount: 0, // stamped with the REAL total below
    };
  }
  if (first === null) return { ...blank, titleMarkStart, titleMarkEnd };
  return { ...first, matchCount };
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

/**
 * Copilot transcript SERVER sync (Phase 07, r10 rec #1).
 *
 * The localStorage store (copilot-sessions.ts) stays the instant cache and
 * offline fallback; this module mirrors mutations to the server so a
 * transcript follows the user ACROSS DEVICES. Everything here is
 * best-effort and silent: sync failures never block or break the chat —
 * the server copy is NOT financial authority (answers are recomputed on
 * every ask; A11-A13) and the local store remains usable offline.
 *
 * Privacy: the API scopes every read/write to (businessId, userId) —
 * a user's questions are their own; other members can never read them.
 */

import type { CopilotSession, StoredCopilotMessage } from "@/lib/copilot-sessions";

/** Server-shaped session (GET /api/v1/copilot/sessions). */
export type ServerCopilotSession = {
  id: string;
  title: string;
  titleEdited?: boolean;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    failed?: boolean;
    meta?: unknown;
    createdAt: string;
  }>;
};

const BASE = "/api/v1/copilot/sessions";

function headers(businessId: string): Record<string, string> {
  return { "content-type": "application/json", "x-business-id": businessId };
}

/** All callers treat sync as fire-and-forget — errors are logged, never thrown. */
function swallow(scope: string): (error: unknown) => void {
  return (error) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[copilot-sync] ${scope} skipped:`, (error as Error)?.message ?? error);
    }
  };
}

/** Fetch the user's server transcripts; null on failure (offline etc.). */
export async function fetchServerSessions(businessId: string): Promise<ServerCopilotSession[] | null> {
  try {
    const res = await fetch(BASE, {
      credentials: "same-origin",
      headers: headers(businessId),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { sessions?: ServerCopilotSession[] } };
    return Array.isArray(body.data?.sessions) ? body.data.sessions : [];
  } catch (error) {
    swallow("fetch")(error);
    return null;
  }
}

/**
 * Append one message; auto-creates the session server-side on first append
 * (title is only consumed when creating). Returns the created message row.
 */
export async function serverAppendMessage(
  businessId: string,
  sessionId: string,
  message: Pick<StoredCopilotMessage, "role" | "content" | "meta">,
  title?: string,
): Promise<{ id: string; createdAt: string } | { skipped: true } | null> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      credentials: "same-origin",
      headers: headers(businessId),
      body: JSON.stringify({
        role: message.role,
        content: message.content,
        ...(message.meta !== undefined ? { meta: message.meta } : {}),
        ...(title ? { title } : {}),
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { skipped?: boolean; message?: { id: string; createdAt: string } };
    };
    if (body.data?.skipped) return { skipped: true };
    return body.data?.message ?? null;
  } catch (error) {
    swallow("append")(error);
    return null;
  }
}

/** Delete one transcript server-side (404 tolerated — already gone). */
export async function serverDeleteSession(businessId: string, sessionId: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: headers(businessId),
    });
    if (!res.ok && res.status !== 404) {
      swallow("delete")(new Error(`status ${res.status}`));
    }
  } catch (error) {
    swallow("delete")(error);
  }
}

/** Clear ALL of the user's transcripts for the business server-side. */
export async function serverClearSessions(businessId: string): Promise<void> {
  try {
    const res = await fetch(BASE, {
      method: "DELETE",
      credentials: "same-origin",
      headers: headers(businessId),
    });
    if (!res.ok) {
      swallow("clear")(new Error(`status ${res.status}`));
    }
  } catch (error) {
    swallow("clear")(error);
  }
}

/**
 * Rename and/or pin one conversation server-side (PATCH). Fire-and-forget:
 * the local mutation has already happened — this is the cross-device mirror.
 */
export async function serverUpdateSession(
  businessId: string,
  sessionId: string,
  patch: { title?: string; pinned?: boolean },
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: headers(businessId),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      swallow("update")(new Error(`status ${res.status}`));
    }
  } catch (error) {
    swallow("update")(error);
  }
}

// ---- Merge (hydration) ------------------------------------------------------

function toLocalSession(s: ServerCopilotSession): CopilotSession {
  const messages: StoredCopilotMessage[] = s.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.failed ? { failed: true } : {}),
    ...(m.meta !== undefined ? { meta: m.meta } : {}),
  }));
  return {
    id: s.id,
    title: s.title ?? "",
    ...(s.titleEdited ? { titleEdited: true } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    createdAt: Date.parse(s.createdAt) || Date.now(),
    updatedAt: Date.parse(s.updatedAt) || Date.now(),
    messages,
  };
}

/**
 * Merge local and server session lists by id — NEWER updatedAt wins per
 * session; sessions present only on one side are kept. This lets a device
 * that just typed offline push forward (its updatedAt is newer) while a
 * second device still receives the rest of the history.
 */
export function mergeWithServer(
  local: CopilotSession[],
  server: ServerCopilotSession[] | null,
): CopilotSession[] {
  if (!server || server.length === 0) return local;
  const byId = new Map<string, CopilotSession>();
  for (const s of local) byId.set(s.id, s);
  for (const raw of server) {
    const incoming = toLocalSession(raw);
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      continue;
    }
    // Server wins ties only when strictly newer AND not shorter (guards the
    // window where a local append landed after the server snapshot).
    const incomingNewer = incoming.updatedAt > current.updatedAt;
    const incomingLonger = incoming.messages.length >= current.messages.length;
    if (incomingNewer && incomingLonger) byId.set(incoming.id, incoming);
  }
  // Pinned first (stable), then newest first.
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

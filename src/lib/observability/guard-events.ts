/**
 * R109/R111 — dev-server RSS-guard event reader (ops visibility).
 *
 * The guard daemon (scripts/dev-rss-guard.cjs) appends human-readable lines
 * to /home/z/my-project/dev-rss-guard.log AND (since R111) mirrors every
 * event as a structured JSONL row ({ts, kind, msg, ...fields}) in
 * dev-rss-guard-events.jsonl. This module turns the TAILS of both files into
 * structured events for the platform console — bounded reads (last 64KB per
 * file), never whole files, and NEVER a write.
 *
 * MERGE LAW (R111): mirrored events are authoritative (exact fields at the
 * source); text-parsed events fill in everything the mirror doesn't cover
 * (pre-R111 history, text-only diagnostic lines). Dedupe key = `at|message`
 * — the guard writes both sinks with ONE timestamp and the same message, so
 * a mirrored event and its text twin collapse into one; a mirrored event
 * whose text twin already rotated away survives alone (the whole point).
 *
 * HONESTY LAWS: missing/unreadable files report `available: false` (per
 * sink) with an empty event list — no invented events, no fabricated status.
 * Malformed JSONL rows are skipped; unknown kinds fall through to "other".
 *
 * Path overrides (tests): GUARD_LOG_PATH for the text log; the mirror path
 * defaults to a SIBLING of the text log (`<log>.events.jsonl`) so a text
 * override never silently reads the production mirror.
 */
import { open, stat } from "node:fs/promises";
import { spawnGroupOf } from "./guard-groups";

export const GUARD_LOG_DEFAULT = "/home/z/my-project/dev-rss-guard.log";
export const GUARD_EVENTS_JSONL_DEFAULT = "/home/z/my-project/dev-rss-guard-events.jsonl";
/** Bounded read — the logs can grow unbounded; never read more than this. */
const MAX_TAIL_BYTES = 64 * 1024;

export type GuardEventKind =
  | "guard-start"
  | "recycle-start"
  | "recycle-done"
  | "spawn-ok"
  | "spawn-failed"
  | "high-rss"
  | "recovered"
  | "refusal"
  | "other";

export type GuardEvent = {
  /** ISO timestamp from the log line; unparseable timestamps keep raw. */
  at: string;
  kind: GuardEventKind;
  /** Full message (log line minus the timestamp bracket). */
  message: string;
  rssMb?: number;
  pid?: number;
  streak?: string;
  /** spawn reason: "recycle" | "down" (self-heal) | raw token. */
  spawnWhy?: string;
  /** R111 — RSS-guard water mark at event time (mirrored events only). */
  waterMb?: number;
  /** R112 — effective water for this sample (base + post-spawn grace headroom). */
  effWaterMb?: number;
  /** R112 — true when this sample was judged inside the post-spawn grace window. */
  graceActive?: boolean;
  /** R112 — daemon's grace policy knobs, mirrored on guard-start rows. */
  graceSamples?: number;
  graceHeadroomMb?: number;
};

export type GuardEventsResult = {
  /** True when at least ONE sink (text log or mirror) was readable. */
  available: boolean;
  /** Text-log tail truncated? true when the file was larger than the window read. */
  truncated: boolean;
  /** R111 — mirror sink state: present, tail-truncated, and how many rows merged. */
  mirror: { available: boolean; truncated: boolean; merged: number };
  /** Newest-first parsed events (bounded by `limit`). */
  events: GuardEvent[];
  summary: {
    /** Most recent event timestamp (ISO), if any. */
    lastEventAt: string | null;
    /** Oldest event timestamp in the returned window (R111 — history depth). */
    firstEventAt: string | null;
    /**
     * R112 — when the CURRENT server generation was spawned (newest
     * spawn-ok in the window). Null when the spawn has aged out of the
     * window (honest absence — never guessed).
     */
    generationStartedAt: string | null;
    counts: Partial<Record<GuardEventKind, number>>;
    /** Most recent "guard started" timestamp, if present in the window. */
    guardStartedAt: string | null;
    /**
     * R113 — highest rssMb observed in the window (any event kind that
     * carries one). Null when no event carries an rss figure.
     */
    peakRssMb: number | null;
    /**
     * R113 — newest recycle completion: when it happened and how much RSS
     * the killed generation held (the guard's own "reclaimed" figure).
     * Null when the window holds no recycle-done event.
     */
    lastRecycle: { at: string; oldRssMb: number } | null;
    /**
     * R113 — mean old-RSS across every recycle-done in the window. Null
     * when there are none (never a fabricated 0).
     */
    avgReclaimedMb: number | null;
    /**
     * R113 — how the successful spawns in the window came to be, grouped
     * by spawnGroupOf (recycle vs self-heal). Absent groups stay 0 — the
     * shape is stable so the UI never special-cases.
     */
    spawnBreakdown: { recycle: number; selfheal: number };
  };
};

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.*)$/;

/** Map a guard log message to a structured event. Never throws. */
export function parseGuardLine(raw: string): GuardEvent | null {
  const m = raw.match(LINE_RE);
  if (!m) return null; // blank/partial line — not an event
  const [, at, message] = m;
  const ev: GuardEvent = { at, kind: "other", message };
  const num = (re: RegExp): number | undefined => {
    const n = message.match(re);
    return n ? Number(n[1]) : undefined;
  };
  if (message.startsWith("guard started")) {
    ev.kind = "guard-start";
    ev.pid = num(/pid=(\d+)/);
  } else if (message.startsWith("RECYCLE start:")) {
    ev.kind = "recycle-start";
    ev.pid = num(/pid=(\d+)/);
    ev.rssMb = num(/rss=(\d+)MB/);
  } else if (message.startsWith("RECYCLE done:")) {
    ev.kind = "recycle-done";
    ev.rssMb = num(/old rss=(\d+)MB/);
  } else if (/^spawn\(([^)]+)\)/.test(message)) {
    ev.spawnWhy = message.match(/^spawn\(([^)]+)\)/)?.[1];
    ev.pid = num(/pid=(\d+)/);
    if (message.includes("GAVE UP")) ev.kind = "spawn-failed";
    else if (/OK after/.test(message)) ev.kind = "spawn-ok";
    else ev.kind = "other"; // attempt progress lines stay raw
  } else if (message.startsWith("high rss:")) {
    ev.kind = "high-rss";
    ev.rssMb = num(/rss:\s*(\d+)MB/);
    ev.streak = message.match(/streak (\d+\/\d+)/)?.[1];
    ev.pid = num(/pid=(\d+)/);
  } else if (message.startsWith("rss recovered:")) {
    ev.kind = "recovered";
    ev.rssMb = num(/recovered:\s*(\d+)MB/);
  } else if (message.includes("refusing") || message.includes("boot-gap")) {
    ev.kind = "refusal";
  }
  return ev;
}

const KNOWN_KINDS = new Set<GuardEventKind>([
  "guard-start",
  "recycle-start",
  "recycle-done",
  "spawn-ok",
  "spawn-failed",
  "high-rss",
  "recovered",
  "refusal",
  "other",
]);

/**
 * Parse one JSONL mirror row into a GuardEvent. Never throws; malformed or
 * shape-invalid rows return null (honest skip). Unknown kinds → "other".
 */
export function parseMirrorLine(raw: string): GuardEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null; // partial/torn row (append raced a tail read) — skip
  }
  if (typeof o !== "object" || o === null) return null;
  const row = o as Record<string, unknown>;
  if (typeof row.ts !== "string" || row.ts.length === 0) return null;
  if (typeof row.kind !== "string") return null;
  const ev: GuardEvent = {
    at: row.ts,
    kind: KNOWN_KINDS.has(row.kind as GuardEventKind) ? (row.kind as GuardEventKind) : "other",
    message: typeof row.msg === "string" ? row.msg : "",
  };
  if (typeof row.rssMb === "number" && Number.isFinite(row.rssMb)) ev.rssMb = row.rssMb;
  if (typeof row.pid === "number" && Number.isFinite(row.pid)) ev.pid = row.pid;
  if (typeof row.streak === "string") ev.streak = row.streak;
  if (typeof row.spawnWhy === "string") ev.spawnWhy = row.spawnWhy;
  if (typeof row.waterMb === "number" && Number.isFinite(row.waterMb)) ev.waterMb = row.waterMb;
  if (typeof row.effWaterMb === "number" && Number.isFinite(row.effWaterMb)) ev.effWaterMb = row.effWaterMb;
  if (typeof row.graceActive === "boolean") ev.graceActive = row.graceActive;
  if (typeof row.graceSamples === "number" && Number.isFinite(row.graceSamples)) ev.graceSamples = row.graceSamples;
  if (typeof row.graceHeadroomMb === "number" && Number.isFinite(row.graceHeadroomMb)) ev.graceHeadroomMb = row.graceHeadroomMb;
  return ev;
}

/** Positional bounded tail read. Returns null when the file is absent/unreadable. */
async function readTail(path: string): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - MAX_TAIL_BYTES);
    const truncated = start > 0;
    const fh = await open(path, "r");
    try {
      const length = st.size - start;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      let text = buf.toString("utf8");
      if (truncated) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
      return { text, truncated };
    } finally {
      await fh.close();
    }
  } catch {
    return null; // missing/unreadable — honesty over invention
  }
}

/**
 * Mirror path law: explicit env override (tests) wins; an overridden TEXT log
 * path (also tests) gets a SIBLING mirror so a fixture never reads the
 * production mirror; otherwise the real production default — the exact path
 * the guard daemon itself writes (scripts/dev-rss-guard.cjs).
 */
export function mirrorPathFor(logPath: string): string {
  if (process.env.GUARD_EVENTS_JSONL_PATH) return process.env.GUARD_EVENTS_JSONL_PATH;
  if (process.env.GUARD_LOG_PATH) return `${logPath}.events.jsonl`;
  return GUARD_EVENTS_JSONL_DEFAULT;
}

/**
 * Parse BOTH bounded tails into one newest-first event list + summary.
 * Mirrored events win dedupe; text-only events fill the gaps. Never throws.
 */
export async function readGuardEvents(limit = 30): Promise<GuardEventsResult> {
  const logPath = process.env.GUARD_LOG_PATH || GUARD_LOG_DEFAULT;
  const mirrorPath = mirrorPathFor(logPath);

  const [textTail, mirrorTail] = await Promise.all([readTail(logPath), readTail(mirrorPath)]);
  if (!textTail && !mirrorTail) {
    return {
      available: false,
      truncated: false,
      mirror: { available: false, truncated: false, merged: 0 },
      events: [],
      summary: {
        lastEventAt: null,
        firstEventAt: null,
        generationStartedAt: null,
        counts: {},
        guardStartedAt: null,
        peakRssMb: null,
        lastRecycle: null,
        avgReclaimedMb: null,
        spawnBreakdown: { recycle: 0, selfheal: 0 },
      },
    };
  }

  // Mirrored events are authoritative — insert them first.
  const byKey = new Map<string, GuardEvent>();
  let mirrored = 0;
  if (mirrorTail) {
    for (const line of mirrorTail.text.split("\n")) {
      if (line.trim().length === 0) continue;
      const ev = parseMirrorLine(line);
      if (!ev) continue;
      mirrored += 1;
      byKey.set(`${ev.at}|${ev.message}`, ev);
    }
  }
  // Text-parsed events fill everything the mirror doesn't already cover.
  if (textTail) {
    for (const line of textTail.text.split("\n")) {
      if (line.trim().length === 0) continue;
      const ev = parseGuardLine(line);
      if (!ev) continue;
      const key = `${ev.at}|${ev.message}`;
      if (!byKey.has(key)) byKey.set(key, ev);
    }
  }

  // ISO timestamps sort lexicographically — newest-first without Date parsing.
  const merged = [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at));
  const window = merged.slice(0, Math.max(1, Math.min(200, limit)));

  const counts: Partial<Record<GuardEventKind, number>> = {};
  for (const ev of window) counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
  const guardStartedAt = window.find((e) => e.kind === "guard-start")?.at ?? null;
  // Generation birth = newest successful spawn in the window (the guard
  // spawns the server; guard-start is the DAEMON's birth, not the server's).
  const generationStartedAt = window.find((e) => e.kind === "spawn-ok")?.at ?? null;

  // R113 — memory story. The window is already newest-first; scanning the
  // whole slice keeps every aggregate honest for the exact window returned.
  let peakRssMb: number | null = null;
  const recycledMb: number[] = [];
  for (const ev of window) {
    if (typeof ev.rssMb === "number" && Number.isFinite(ev.rssMb)) {
      peakRssMb = peakRssMb === null ? ev.rssMb : Math.max(peakRssMb, ev.rssMb);
    }
    if (ev.kind === "recycle-done" && typeof ev.rssMb === "number" && Number.isFinite(ev.rssMb)) {
      recycledMb.push(ev.rssMb);
    }
  }
  const lastRecycleEvent = window.find((e) => e.kind === "recycle-done" && typeof e.rssMb === "number");
  const avgReclaimedMb =
    recycledMb.length > 0
      ? Math.round(recycledMb.reduce((a, b) => a + b, 0) / recycledMb.length)
      : null;
  const spawnBreakdown = { recycle: 0, selfheal: 0 };
  for (const ev of window) {
    if (ev.kind !== "spawn-ok") continue;
    const g = spawnGroupOf(ev.spawnWhy);
    if (g === "recycle") spawnBreakdown.recycle += 1;
    else if (g === "selfheal") spawnBreakdown.selfheal += 1;
  }

  return {
    available: true,
    truncated: textTail?.truncated ?? false,
    mirror: {
      available: mirrorTail !== null,
      truncated: mirrorTail?.truncated ?? false,
      merged: mirrored,
    },
    events: window,
    summary: {
      lastEventAt: window[0]?.at ?? null,
      firstEventAt: window.length > 0 ? window[window.length - 1].at : null,
      generationStartedAt,
      counts,
      guardStartedAt,
      peakRssMb,
      lastRecycle:
        lastRecycleEvent && typeof lastRecycleEvent.rssMb === "number"
          ? { at: lastRecycleEvent.at, oldRssMb: lastRecycleEvent.rssMb }
          : null,
      avgReclaimedMb,
      spawnBreakdown,
    },
  };
}

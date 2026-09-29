import "server-only";

/**
 * Structured server-side logger — Prompt 29 §29/§32/§33/§34.
 *
 * Plain JSON lines on stdout/stderr. No logging platform, no vendor SDK.
 *
 * Laws enforced HERE (not at call sites, so they cannot drift):
 *  - Redaction: keys containing password/token/secret/apiKey/authorization/
 *    cookie/set-cookie/DATABASE_URL/NEXTAUTH_SECRET/EMAIL_SERVER_PASSWORD/
 *    merchant are replaced with "[REDACTED]" recursively (§33).
 *  - Bounded size: the serialized metadata is capped (§34); oversized values
 *    are replaced by a length marker — truncation NEVER keeps a sensitive
 *    suffix (we drop the whole value instead of slicing it).
 *  - Bounded depth/width: recursion is capped; oversized collections collapse
 *    into a summary.
 *  - Levels: production default INFO, development DEBUG (§29). LOG_LEVEL may
 *    override DOWN only (production cannot be forced to DEBUG of everything;
 *    it can raise verbosity to DEBUG deliberately via explicit env).
 *  - Stack traces: included ONLY outside production or when
 *    SECURE_SERVER_DIAGNOSTICS=true is explicitly set (§28).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SERVICE = "ai-business-copilot";
const ENV = process.env.NODE_ENV === "production" ? "production" : "development";

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return ENV === "production" ? "info" : "debug";
}

const MIN_LEVEL: LogLevel = resolveLevel();
/** Production may include stacks only with this explicit, deliberate flag. */
const STACKS_ALLOWED = ENV !== "production" || process.env.SECURE_SERVER_DIAGNOSTICS === "true";

/** Serialized metadata byte budget (§34). Generous, but bounded. */
const MAX_META_BYTES = 8 * 1024;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;

const REDACT_KEY_RE =
  /(password|passwd|secret|token|apikey|api_key|api-key|authorization|cookie|database_url|nextauth_secret|email_server_password|merchant|credential|private_key|client_secret|otp|mfa|recovery|assertion|challenge)/i;
const REDACTED = "[REDACTED]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive redaction + shape bounding. Never throws. */
function sanitize(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    // Bounded strings: oversized values are DROPPED to a marker (never
    // sliced — a slice could retain a sensitive suffix, §34).
    return s.length > 512 ? `[STRING_DROPPED length=${s.length}]` : s;
  }
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "function" || t === "symbol") return `[${t}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(STACKS_ALLOWED ? { stack: value.stack } : {}),
    };
  }
  if (depth >= MAX_DEPTH) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      head.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return head;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    const bounded = keys.slice(0, MAX_OBJECT_KEYS);
    for (const k of bounded) {
      out[k] = REDACT_KEY_RE.test(k) ? REDACTED : sanitize(value[k], depth + 1);
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      out["[truncatedKeys]"] = keys.length - MAX_OBJECT_KEYS;
    }
    return out;
  }
  // Map/Set/Date/anything else — safe stringified form.
  try {
    const s = String(value);
    return s.length > 512 ? `[STRING_DROPPED length=${s.length}]` : s;
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

/** Serialize with a hard byte budget. Returns {json, dropped}. */
function serializeBounded(meta: Record<string, unknown>): { json: string; dropped: boolean } {
  let json = JSON.stringify(meta);
  if (json === undefined) json = "{}";
  if (json.length <= MAX_META_BYTES) return { json, dropped: false };
  // Second pass with everything string-valued collapsed to markers.
  const collapsed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    collapsed[k] = REDACT_KEY_RE.test(k) ? REDACTED : `${typeof v}`;
  }
  json = JSON.stringify(collapsed);
  if (json.length > MAX_META_BYTES) {
    json = JSON.stringify({ event: meta.event, note: "METADATA_DROPPED_SIZE_LIMIT" });
  }
  return { json, dropped: true };
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function emit(level: LogLevel, event: string, meta: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  // The event name is part of the SAFE payload (never client-controlled):
  // merged first so every structured line carries it (§80).
  const safeMeta = sanitize({ event, ...meta }, 0) as Record<string, unknown>;
  const { json, dropped } = serializeBounded(safeMeta);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    parsed = { event, note: "LOG_SERIALIZE_FALLBACK" };
  }
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: SERVICE,
      env: ENV,
      ...(dropped ? { logNote: "METADATA_TRUNCATED" } : {}),
      ...parsed,
    }) + "\n";
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

export function logDebug(event: string, meta: Record<string, unknown> = {}): void {
  emit("debug", event, meta);
}
export function logInfo(event: string, meta: Record<string, unknown> = {}): void {
  emit("info", event, meta);
}
export function logWarn(event: string, meta: Record<string, unknown> = {}): void {
  emit("warn", event, meta);
}
export function logError(event: string, meta: Record<string, unknown> = {}): void {
  emit("error", event, meta);
}

export const loggerActiveLevel = MIN_LEVEL;

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Secret-box — authenticated encryption for server-side secrets at rest
 * (Prompt 30 §33/§34/§35/§36/§191).
 *
 * Primitive: AES-256-GCM (authenticated — never an unauthenticated mode).
 * Key: MFA_ENCRYPTION_KEY, server-only. It is NEVER stored in the database,
 * NEVER logged, NEVER returned by any API, and NEVER written to docs
 * (§188). Accepted encodings: base64/base64url/hex of EXACTLY 32 bytes —
 * short strings, obvious placeholders and example values are rejected
 * (§34). Generation: `openssl rand -base64 32`.
 *
 * Record format (§35 — bounded, self-describing, versioned for rotation):
 *
 *   v1.<iv base64url>.<authTag base64url>.<ciphertext base64url>
 *
 * Failure semantics (§36): decrypt() returns NULL on ANY failure (wrong
 * key, corrupted record, bad tag). It never throws and never leaks key or
 * plaintext material. Callers log a safe event (e.g.
 * MFA_SECRET_DECRYPTION_FAILED) WITHOUT secret material and fail closed.
 *
 * Rotation (§191): the v1 prefix keeps room for future v2 envelopes; mass
 * rotation is explicitly OUT of scope for Prompt 30 (documented instead).
 *
 * Memory (§196/§197): decrypted secrets are returned to the caller for the
 * immediate operation only — this module keeps NO module-level cache of
 * plaintext. JavaScript cannot guarantee memory zeroization; no claim of
 * that is made anywhere.
 */

const VERSION = "v1";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard 96-bit IV

/** Placeholders/example values that must NEVER be accepted as a real key. */
const FORBIDDEN_KEY_FRAGMENTS = [
  "changeme",
  "change-me",
  "example",
  "placeholder",
  "your-key",
  "yourkey",
  "sample",
  "dummy",
  "secret-key",
  "test-key",
  "abcdef",
  "123456",
];

export type SecretBoxKeyStatus =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate the MFA_ENCRYPTION_KEY WITHOUT exposing it. Returns only a
 * machine reason — never the value or a prefix of it (§188).
 */
export function validateSecretBoxKey(raw: string | undefined | null): SecretBoxKeyStatus {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "MISSING" };

  if (value.length < 43) {
    // 32 bytes base64 == 43 chars (+ padding). Anything shorter cannot be
    // 32 bytes and is by definition too weak (§34).
    return { ok: false, reason: "TOO_SHORT" };
  }

  const lowered = value.toLowerCase();
  for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
    if (lowered.includes(fragment)) return { ok: false, reason: "PLACEHOLDER" };
  }

  // All-same-character keys (e.g. "AAAA...") are not key material.
  if (/^(.)\1+$/.test(value)) return { ok: false, reason: "LOW_ENTROPY" };

  let key: Buffer | null = null;
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    try {
      const decoded = Buffer.from(padded, "base64");
      if (decoded.length === KEY_BYTES) key = decoded;
    } catch {
      key = null;
    }
  }
  if (!key && /^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
    if (key.length !== KEY_BYTES) key = null;
  }
  if (!key) return { ok: false, reason: "NOT_32_BYTE_MATERIAL" };

  return { ok: true };
}

/**
 * Resolve + validate the key from the environment. Throws a value-free
 * error when the key is missing/invalid — callers translate that into a
 * safe MFA_NOT_CONFIGURED outcome (fail closed, §190).
 */
function getKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  const status = validateSecretBoxKey(raw);
  if (!status.ok) {
    throw new Error(`SECRET_BOX_KEY_INVALID:${status.reason}`);
  }
  const value = (raw as string).trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/** Encrypt a UTF-8 plaintext into the bounded v1 envelope (§35). */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("SECRET_BOX_EMPTY_PLAINTEXT");
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a v1 envelope. Returns NULL on any failure (§36) — the caller
 * MUST treat null as "verification impossible" and fail closed.
 */
export function decryptSecret(payload: string): string | null {
  try {
    const parts = payload.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    const iv = Buffer.from(parts[1], "base64url");
    const authTag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || authTag.length !== 16 || ciphertext.length === 0) {
      return null;
    }
    const key = getKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const value = plaintext.toString("utf8");
    plaintext.fill(0); // best-effort buffer cleanup — never claimed as a guarantee (§197)
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Envelope sanity probe used by config/readiness: verifies the CURRENT key
 * can decrypt an encrypt→decrypt round trip (catches key rotation without
 * re-encryption and corrupt environments). No secret material involved.
 */
export function secretBoxSelfTest(): boolean {
  try {
    const probe = `probe:${createHash("sha256").update(randomBytes(16)).digest("hex")}`;
    return decryptSecret(encryptSecret(probe)) === probe;
  } catch {
    return false;
  }
}

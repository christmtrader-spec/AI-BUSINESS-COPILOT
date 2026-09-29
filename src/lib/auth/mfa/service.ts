import "server-only";
import { createHash, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { db } from "@/lib/db";
import {
  RECOVERY_CODES_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW_STEPS,
} from "@/lib/auth/config";
import {
  decryptSecret,
  encryptSecret,
  validateSecretBoxKey,
} from "@/lib/security/secret-box";
import { logError } from "@/lib/observability/logger";

/**
 * MFA service — Prompt 30 §28-§45, §106-§108, §191-§197, §213.
 *
 * TOTP: RFC 6238-compatible via the maintained `otpauth` library —
 * SHA-1 HMAC, 6 digits, 30-second period (§29/§30 — the RFC-compatible
 * default that every mainstream authenticator app supports). The
 * cryptographic algorithm is NEVER hand-rolled (§28).
 *
 * Secret generation (§31): 20 cryptographically random bytes → base32.
 * NEVER derived from email/userId/password/time.
 *
 * Secret storage (§32/§33): AES-256-GCM secret-box envelope. Plaintext
 * exists only inside the immediate verify operation (§196/§197 — no
 * module cache, no guaranteed zeroization claim).
 *
 * Decryption failure (§36): verify fails CLOSED with a safe error; a
 * value-free operational error is logged (MFA_SECRET_DECRYPTION_FAILED).
 *
 * Replay protection (§45): the credential stores the last accepted TOTP
 * time-step; the same-or-older step is rejected at login. Future steps
 * are never permanently rejected (§45).
 *
 * Clock skew (§44): window ±1 step (±30s around server time, §192 —
 * server time only, never client time). Documented, bounded, standard.
 */

const ISSUER = "AI Business Copilot";

export class MfaServiceError extends Error {
  constructor(
    public code:
      | "MFA_NOT_CONFIGURED"
      | "MFA_ALREADY_ENABLED"
      | "MFA_NOT_ENABLED"
      | "MFA_SECRET_DECRYPTION_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** Feature gate (§184): the deployment must explicitly enable MFA. */
export function assertMfaFeatureAvailable(): void {
  const enabled =
    (process.env.MFA_ENABLED ?? "").trim().toLowerCase() === "true";
  if (!enabled) {
    throw new MfaServiceError(
      "MFA_NOT_CONFIGURED",
      "Two-factor authentication is not available in this deployment.",
    );
  }
}

/** Key check (§34/§190): fail closed with a safe, value-free error. */
export function assertMfaKeyConfigured(): void {
  const status = validateSecretBoxKey(process.env.MFA_ENCRYPTION_KEY);
  if (!status.ok) {
    throw new MfaServiceError(
      "MFA_NOT_CONFIGURED",
      "Two-factor authentication is not available in this deployment.",
    );
  }
}

/** 20 random bytes → RFC 4648 base32 (otpauth-compatible, §31/§349). */
export function generateTotpSecret(): string {
  // Cryptographically random 20 bytes; converted to base32 via otpauth's
  // hex path (avoids the library's ArrayBuffer generic typing quirk).
  return OTPAuth.Secret.fromHex(randomBytes(20).toString("hex")).base32;
}

/**
 * Standard otpauth provisioning URI (§41): issuer + account from TRUSTED
 * server values (the authenticated user's email — never client input).
 * The URI contains the secret; it is returned ONCE during setup over an
 * authenticated response, never logged, never placed in a URL (§40/§105).
 */
export function buildProvisioningUri(secretBase32: string, accountEmail: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: accountEmail,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

export type TotpVerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: "FORMAT" | "NO_MATCH" | "REPLAY" | "DECRYPT_FAILED" };

/** Exact six-digit format gate before any crypto work (§43/§130-analog). */
export function isPlausibleTotpCode(code: unknown): code is string {
  return typeof code === "string" && /^[0-9]{6}$/.test(code);
}

/**
 * Verify a TOTP code against a base32 secret (§43):
 *  - bounded skew window (§44): current step ±1;
 *  - replay protection (§45): a step ≤ lastUsedStep is rejected;
 *  - server time only (§192);
 *  - no secret material in any error path.
 */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  lastUsedStep: number | null,
): TotpVerifyResult {
  if (!isPlausibleTotpCode(code)) return { ok: false, reason: "FORMAT" };

  let secret: OTPAuth.Secret;
  try {
    secret = OTPAuth.Secret.fromBase32(secretBase32);
  } catch {
    return { ok: false, reason: "DECRYPT_FAILED" };
  }

  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: "verify",
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });

  // otpauth validate() with window W checks steps [current-W, current+W].
  const matched = totp.validate({ token: code, window: TOTP_WINDOW_STEPS });
  if (matched === null) return { ok: false, reason: "NO_MATCH" };

  // validate() returns the OFFSET from the current step (negative = past).
  // Convert to the absolute counter: counter = currentStep + offset.
  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const step = currentStep + matched;

  if (lastUsedStep !== null && step <= lastUsedStep) {
    return { ok: false, reason: "REPLAY" };
  }
  return { ok: true, step };
}

/* ------------------------------ recovery codes ----------------------------- */

/**
 * Crockford-style base32 alphabet (§193): excludes I, L, O, U — the classic
 * transcription traps. 0/1 remain but lookalikes typed by the user (O→0,
 * I/L→1) are normalized before hashing, so a misread letter still resolves
 * to the same code. The alphabet MUST be exactly 32 unique characters
 * (5-bit index space) — verified at module load so an editing mistake can
 * never silently corrupt generated codes.
 */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
if (RECOVERY_ALPHABET.length !== 32 || new Set(RECOVERY_ALPHABET).size !== 32) {
  throw new Error("RECOVERY_ALPHABET_MUST_BE_32_UNIQUE_CHARS");
}

export function generateRecoveryCodes(count = RECOVERY_CODES_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(16); // 16 bytes → 20 alphabet chars → 4 groups
    const bits = Array.from(bytes)
      .map((b) => b.toString(2).padStart(8, "0"))
      .join("");
    let chars = "";
    for (let j = 0; j < 16; j += 1) {
      chars += RECOVERY_ALPHABET[parseInt(bits.slice(j * 5, j * 5 + 5), 2) % 32];
    }
    codes.push(
      `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`,
    );
  }
  return codes;
}

/**
 * Safe normalization (§194): trim, uppercase, strip spaces/dashes, and map
 * typed lookalikes (O→0, I→1, L→1 — Crockford). Does NOT weaken entropy —
 * the canonical form is what gets hashed.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** SHA-256 of the normalized code — hash-only persistence (§59/§195). */
export function hashRecoveryCode(rawOrNormalized: string): string {
  return createHash("sha256")
    .update(normalizeRecoveryCode(rawOrNormalized))
    .digest("hex");
}

/* --------------------------- credential operations ------------------------- */

export type MfaCredentialRow = {
  id: string;
  userId: string;
  encryptedSecret: string;
  enabledAt: Date | null;
  lastUsedTotpStep: number | null;
};

/** Explicit select — ORM objects never cross the service boundary (§198). */
export function mfaCredentialSelect() {
  return {
    id: true,
    userId: true,
    encryptedSecret: true,
    enabledAt: true,
    lastUsedTotpStep: true,
  } as const;
}

/** Does the user have an ACTIVE (enabled) MFA credential? (§38 — pending
 * setup rows never count.) */
export async function userHasMfaEnabled(userId: string): Promise<boolean> {
  const cred = await db.mfaCredential.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  return cred?.enabledAt !== null && cred?.enabledAt !== undefined;
}

/**
 * Decrypt + verify a code against the stored credential. Fails closed on
 * decryption failure with the safe MFA_SECRET_DECRYPTION_FAILED error and
 * a value-free operational log (§36).
 */
export async function verifyMfaCodeForCredential(
  credential: MfaCredentialRow,
  code: string,
  opts: { enforceReplay?: boolean } = {},
): Promise<TotpVerifyResult> {
  const secret = decryptSecret(credential.encryptedSecret);
  if (secret === null) {
    logError("mfa.secret_decryption_failed", {
      userId: credential.userId,
      credentialId: credential.id,
      // NEVER the secret, the envelope, or any key material (§36/§207).
    });
    throw new MfaServiceError(
      "MFA_SECRET_DECRYPTION_FAILED",
      "Two-factor verification is temporarily unavailable.",
    );
  }
  try {
    return verifyTotpCode(
      secret,
      code,
      opts.enforceReplay === false ? null : credential.lastUsedTotpStep,
    );
  } finally {
    // Best-effort immediate scope drop (§196 — no cache, minimal lifetime).
    secret.length.toString();
  }
}

/**
 * Atomic single-use recovery-code claim (§62): updateMany on usedAt IS
 * NULL — concurrent reuse lets exactly one request win (§62/§214).
 */
export async function claimRecoveryCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const codeHash = hashRecoveryCode(code);
  const claimed = await db.mfaRecoveryCode.updateMany({
    where: { userId, codeHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1;
}

/** Remaining recovery codes — the COUNT is not secret (§64); hashes never
 * leave the database. */
export async function remainingRecoveryCodeCount(userId: string): Promise<number> {
  return db.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
}

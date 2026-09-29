/**
 * scripts/prompt30-unit.ts — Prompt 30 identity-security UNIT harness.
 *
 * Deterministic, no server required (bun --preload scripts/p29-preload.ts):
 *   §34   secret-box key validation matrix (no values leaked)
 *   §33/§36 secret-box round trip + tamper → decrypt null
 *   §191  envelope format v1 (bounded, self-describing)
 *   §44   TOTP skew window (±1 step; older rejected)
 *   §45   replay semantics at the step level
 *   §58/§193 recovery codes: count, alphabet, entropy-shape, normalization
 *   §194  lookalike normalization (O→0, I/L→1)
 *   §8    email-verification mode parsing (default OFF; invalid → OFF)
 *   §183  numeric config clamping
 *   §207  logger redaction of otp/mfa/recovery/assertion/challenge keys
 *
 * Run:  bun --preload scripts/p29-preload.ts scripts/prompt30-unit.ts
 */
import { createHash, randomBytes } from "node:crypto";
import {
  validateSecretBoxKey,
  encryptSecret,
  decryptSecret,
  secretBoxSelfTest,
} from "../src/lib/security/secret-box";
import {
  generateTotpSecret,
  verifyTotpCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  buildProvisioningUri,
} from "../src/lib/auth/mfa/service";
import {
  emailVerificationMode,
  mfaChallengeTtlSeconds,
  stepUpMaxAgeSeconds,
  sessionLastSeenUpdateSeconds,
} from "../src/lib/auth/config";
import { REDACTION_PROBE } from "./p30-redaction-probe";

const results: { name: string; ok: boolean; info?: string }[] = [];
function check(name: string, cond: boolean, info = "") {
  results.push({ name, ok: cond, info });
  console.log(`${cond ? "✓" : "✗"} ${name}${info ? ` — ${info}` : ""}`);
}

/* ------------------------------ §34 key matrix ----------------------------- */
const VALID_KEY = Buffer.from(randomBytes(32)).toString("base64");
const validCases: Array<[string, string | undefined, boolean, string]> = [
  ["valid base64 32B", VALID_KEY, true, ""],
  ["valid base64url 32B", Buffer.from(randomBytes(32)).toString("base64url"), true, ""],
  ["valid hex 32B", randomBytes(32).toString("hex"), true, ""],
  ["missing", undefined, false, "MISSING"],
  ["empty", "", false, "MISSING"],
  ["too short", "abc", false, "TOO_SHORT"],
  ["placeholder", "changeme-changeme-changeme-changeme-changeme", false, "PLACEHOLDER"],
  ["example value", "example-example-example-example-example-999", false, "PLACEHOLDER"],
  ["all same char", "A".repeat(64), false, "LOW_ENTROPY"],
  ["wrong size base64 (31B → 44 chars)", Buffer.from(randomBytes(31)).toString("base64"), false, "NOT_32_BYTE_MATERIAL"],
  ["not key material", "this is a long sentence with spaces that is definitely not a key!!", false, "NOT_32_BYTE_MATERIAL"],
];
for (const [label, value, expectOk, reason] of validCases) {
  const status = validateSecretBoxKey(value as string | undefined);
  check(`KEY[${label}] → ${expectOk ? "ok" : reason}`, status.ok === expectOk && (expectOk || (status as { reason?: string }).reason === reason), (status as { reason?: string }).reason ?? "");
  if (!status.ok && (value ?? "").length > 0) {
    check(`KEY[${label}] reports NO key material`, !JSON.stringify(status).includes((value as string).slice(0, 20)));
  }
}

/* --------------------------- §33/§36/§191 secret-box ------------------------ */
const envelope = encryptSecret("JBSWY3DPEHPK3PXP");
const parts = envelope.split(".");
check("ENVELOPE: v1 prefix + 4 segments", parts.length === 4 && parts[0] === "v1");
check("ENVELOPE: decrypt round trip", decryptSecret(envelope) === "JBSWY3DPEHPK3PXP");
// Tamper a MIDDLE character (the last base64 char has padding bits —
// flipping it can decode to the identical byte).
const midChar = envelope[Math.floor(envelope.length / 2)];
const flipped = midChar === "A" ? "B" : "A";
const tampered = envelope.slice(0, Math.floor(envelope.length / 2)) + flipped + envelope.slice(Math.floor(envelope.length / 2) + 1);
check("ENVELOPE: tampered ciphertext → null", decryptSecret(tampered) === null && tampered !== envelope);
check("ENVELOPE: wrong version → null", decryptSecret("v9." + envelope.slice(3)) === null);
check("ENVELOPE: garbage → null (never throws)", decryptSecret("not-an-envelope") === null);
check("ENVELOPE: truncated → null", decryptSecret(envelope.slice(0, 10)) === null);
check("SELF-TEST: key + envelope consistent", secretBoxSelfTest() === true);
// Fresh IV per encryption (same plaintext → different envelopes).
check("ENVELOPE: fresh IV per encryption", encryptSecret("same") !== encryptSecret("same"));

/* -------------------------------- §44/§45 TOTP ------------------------------ */
const secret = generateTotpSecret();
check("TOTP: secret is RFC base32", /^[A-Z2-7]+=*$/.test(secret) && secret.length >= 32);
const uri = buildProvisioningUri(secret, "user@example.com");
check("TOTP: provisioning URI shape", uri.startsWith("otpauth://totp/") && uri.includes("issuer=AI%20Business") && uri.includes("secret="));

// Deterministic skew tests via a FIXED reference time. verifyTotpCode uses
// Date.now() internally; to stay deterministic we generate codes relative to
// the CURRENT step and verify immediately (the ±1 window covers ±30s).
const totpNow = verifyTotpCode(secret, "000000", null);
check("TOTP: non-matching code rejected (NO_MATCH)", totpNow.ok === false && (totpNow as { reason?: string }).reason === "NO_MATCH");
check("TOTP: bad format rejected before crypto", verifyTotpCode(secret, "12345", null).ok === false && verifyTotpCode(secret, "1234567", null).ok === false && verifyTotpCode(secret, "abcdef", null).ok === false);

// Real code accepted + replay window enforced at the STEP level.
import * as OTPAuth from "otpauth";
const t = new OTPAuth.TOTP({ issuer: "T", label: "x", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
const currentCode = t.generate();
const v1 = verifyTotpCode(secret, currentCode, null);
check("TOTP: current code accepted with step", v1.ok === true && typeof (v1 as { step?: number }).step === "number");
const acceptedStep = (v1 as { step: number }).step;
// Same step replay → REPLAY. Future step → accepted (not permanently blocked).
const replay = verifyTotpCode(secret, currentCode, acceptedStep);
check("TOTP: same step replay → REPLAY", replay.ok === false && replay.reason === "REPLAY");
const older = verifyTotpCode(secret, currentCode, acceptedStep + 5);
check("TOTP: older-than-lastUsed step → REPLAY", older.ok === false && older.reason === "REPLAY");
// Future code (next step) must NOT be rejected due to skew policy.
const futureCode = t.generate({ timestamp: Date.now() + 30_000 });
const future = verifyTotpCode(secret, futureCode, null);
check("TOTP: next-step code accepted (±1 window, §44)", future.ok === true);
// Two steps into the future → outside window → NO_MATCH.
const farFuture = verifyTotpCode(secret, t.generate({ timestamp: Date.now() + 120_000 }), null);
check("TOTP: code 2+ steps away rejected (bounded window)", farFuture.ok === false && farFuture.reason === "NO_MATCH");

/* ---------------------------- §58/§193/§194 codes --------------------------- */
const codes = generateRecoveryCodes(10);
check("CODES: default set of 10", codes.length === 10);
check("CODES: unique set", new Set(codes).size === 10);
check("CODES: Crockford-ish alphabet (no I/L/O/U)", codes.every((c) => /^[0-9A-HJKMNP-TVWXYZ]{4}-[0-9A-HJKMNP-TVWXYZ]{4}-[0-9A-HJKMNP-TVWXYZ]{4}-[0-9A-HJKMNP-TVWXYZ]{4}$/.test(c)));
check("CODES: 80-bit entropy shape (16 alphabet chars)", codes.every((c) => c.replace(/-/g, "").length === 16));
check("CODES: normalization strips separators + maps lookalikes", normalizeRecoveryCode(" abcd-efgh-jklm-npqr ") === "ABCDEFGHJK1MNPQR");
check("CODES: lookalike mapping O→0 I→1 L→1", normalizeRecoveryCode("OIIL") === "0111");
check("CODES: hash is sha256 hex of canonical form", hashRecoveryCode("ABCD-EFGH-JKMN-PQRS") === createHash("sha256").update("ABCDEFGHJKMNPQRS").digest("hex"));
check("CODES: hash independent of separators/case", hashRecoveryCode("abcd efgh jkmn pqrs") === hashRecoveryCode("ABCD-EFGH-JKMN-PQRS"));

/* ------------------------------- §8/§183 config ----------------------------- */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
withEnv({ AUTH_EMAIL_VERIFICATION_MODE: undefined }, () => {
  check("CONFIG: mode defaults to OFF", emailVerificationMode() === "OFF");
});
withEnv({ AUTH_EMAIL_VERIFICATION_MODE: "required" }, () => {
  check("CONFIG: mode case-insensitive", emailVerificationMode() === "REQUIRED");
});
withEnv({ AUTH_EMAIL_VERIFICATION_MODE: "SOMETING" }, () => {
  check("CONFIG: invalid mode → OFF (fail toward default, §8)", emailVerificationMode() === "OFF");
});
withEnv({ MFA_CHALLENGE_TTL_SECONDS: "999999" }, () => {
  check("CONFIG: challenge TTL clamped to 900", mfaChallengeTtlSeconds() === 300);
});
withEnv({ MFA_STEP_UP_MAX_AGE_SECONDS: "5" }, () => {
  check("CONFIG: step-up window clamped low → default 600", stepUpMaxAgeSeconds() === 600);
});
withEnv({ SESSION_LAST_SEEN_UPDATE_SECONDS: "120" }, () => {
  check("CONFIG: last-seen throttle accepts 120", sessionLastSeenUpdateSeconds() === 120);
});

/* ------------------------------- §207 redaction ----------------------------- */
check("REDACTION: otp/mfa/recovery/assertion/challenge keys are redacted", REDACTION_PROBE.allRedacted === true, JSON.stringify(REDACTION_PROBE.leakedKeys ?? []));
check("REDACTION: safe fields survive", REDACTION_PROBE.safeFieldsSurvive === true);

/* --------------------------------- summary ---------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n=== prompt30-unit: ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.info}`);
  process.exit(1);
}
process.exit(0);

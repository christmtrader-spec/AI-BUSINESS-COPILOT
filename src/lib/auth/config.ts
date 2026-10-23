import "server-only";

/**
 * Identity-security configuration — Prompt 30 §6/§8/§47/§115/§183/§184.
 *
 * ONE server-side authority for every identity-security knob. TTLs and
 * windows are NEVER duplicated across routes (§6/§115): every consumer
 * imports from here.
 *
 * Configuration contract (§183 — avoid unnecessary variables):
 *  - AUTH_EMAIL_VERIFICATION_MODE   OFF | OPTIONAL | REQUIRED (default OFF)
 *  - MFA_ENABLED                    "true" enables the MFA capability
 *                                   (default false — §184: never silently
 *                                   activated for existing users)
 *  - MFA_ENCRYPTION_KEY             32-byte AES-256 key material (required
 *                                   when MFA_ENABLED=true in production —
 *                                   §190 fail closed)
 *  - MFA_CHALLENGE_TTL_SECONDS      login challenge TTL (default 300, §47)
 *  - MFA_STEP_UP_MAX_AGE_SECONDS    recent-auth window (default 600, §115)
 *  - SESSION_LAST_SEEN_UPDATE_SECONDS  last-seen write throttle (default 300)
 *
 * Every numeric env is parsed defensively and clamped to a safe range;
 * invalid values fall back to the documented default (never crash startup).
 */

/* ----------------------------- email verification ------------------------- */

export const EMAIL_VERIFICATION_TTL_MINUTES = 30;

export type EmailVerificationMode = "OFF" | "OPTIONAL" | "REQUIRED";

const EMAIL_VERIFICATION_MODES: readonly EmailVerificationMode[] = [
  "OFF",
  "OPTIONAL",
  "REQUIRED",
];

/**
 * §8/§449 — default OFF so an upgrade can never lock existing users out.
 * An invalid configured value resolves to OFF (fail toward the LEAST
 * restrictive documented default; REQUIRED is only ever active when it is
 * explicitly and correctly spelled).
 */
export function emailVerificationMode(): EmailVerificationMode {
  const raw = (process.env.AUTH_EMAIL_VERIFICATION_MODE ?? "")
    .trim()
    .toUpperCase();
  return (EMAIL_VERIFICATION_MODES as readonly string[]).includes(raw)
    ? (raw as EmailVerificationMode)
    : "OFF";
}

/* ------------------------------------ MFA --------------------------------- */

/** §184/§450 — capability switch. Default false. Never force-migrated. */
export function mfaFeatureEnabled(): boolean {
  return (process.env.MFA_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** §47 — challenge TTL. Default 5 minutes, bounded 60s–900s. */
export function mfaChallengeTtlSeconds(): number {
  const n = Number((process.env.MFA_CHALLENGE_TTL_SECONDS ?? "").trim());
  return Number.isFinite(n) && n >= 60 && n <= 900 ? Math.floor(n) : 300;
}

/** §115 — recent-auth window for destructive operations. 5–30 minutes. */
export function stepUpMaxAgeSeconds(): number {
  const n = Number((process.env.MFA_STEP_UP_MAX_AGE_SECONDS ?? "").trim());
  return Number.isFinite(n) && n >= 300 && n <= 1800 ? Math.floor(n) : 600;
}

/** §85/§434 — last-seen write throttle (prevents SQLite write amplification). */
export function sessionLastSeenUpdateSeconds(): number {
  const n = Number((process.env.SESSION_LAST_SEEN_UPDATE_SECONDS ?? "").trim());
  return Number.isFinite(n) && n >= 60 && n <= 3600 ? Math.floor(n) : 300;
}

/* ------------------------------ fixed policies --------------------------- */

/** JWT + UserSession expiry MUST agree (§84). Single authority. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/* ---------------------- platform MFA enforcement (R65) -------------------- */

/**
 * Platform MFA enforcement policy — Prompt 65 §6.2. ONE authority; read
 * PER REQUEST so a deployment policy change takes effect without a restart
 * (and tests/probes always observe the live policy).
 *
 *   OFF            MFA is never required for platform access (explicit
 *                  opt-out; documented, audited deployments only).
 *   SUPER_ADMIN    (DEFAULT — the Prompt 65 target policy) every
 *                  PLATFORM_SUPER_ADMIN must have an ACTIVE MFA credential
 *                  before ANY privileged platform response is served. Other
 *                  operator roles follow the deployment's documented policy.
 *   ALL_OPERATORS  every active platform operator needs MFA.
 *
 * Fail-closed law (§6.2/§10): when the policy requires MFA and the MFA
 * capability is NOT AVAILABLE (feature off, key missing/invalid — BLOCKED),
 * privileged access is DENIED, never silently degraded to password-only.
 * The error code is PLATFORM_MFA_REQUIRED (value-free) — it never reveals
 * WHY the capability is unavailable and never leaks key state.
 */
export type PlatformMfaEnforcement = "OFF" | "SUPER_ADMIN" | "ALL_OPERATORS";

const PLATFORM_MFA_ENFORCEMENT_MODES: readonly PlatformMfaEnforcement[] = [
  "OFF",
  "SUPER_ADMIN",
  "ALL_OPERATORS",
];

export function platformMfaEnforcement(): PlatformMfaEnforcement {
  const raw = (process.env.PLATFORM_MFA_ENFORCEMENT ?? "").trim().toUpperCase();
  return (PLATFORM_MFA_ENFORCEMENT_MODES as readonly string[]).includes(raw)
    ? (raw as PlatformMfaEnforcement)
    : "SUPER_ADMIN";
}

/** Does the given platform role require MFA under the active policy? */
export function platformRoleRequiresMfa(role: string): boolean {
  const mode = platformMfaEnforcement();
  if (mode === "OFF") return false;
  if (mode === "ALL_OPERATORS") return true;
  return role === "PLATFORM_SUPER_ADMIN";
}

/** §58 — recovery code set size. Always 10; never fewer (§108). */
export const RECOVERY_CODES_COUNT = 10;

/** §56/§57 — wrong codes allowed per challenge before it is invalidated. */
export const MFA_MAX_ATTEMPTS_PER_CHALLENGE = 5;

/**
 * §44 — clock-skew policy: codes from the previous/current/next 30-second
 * step are accepted (±30s around server time, standard authenticator
 * behavior). Older codes are never accepted (§44).
 */
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** §21 — single active verification token per user (enforced at issuance). */
export const EMAIL_TOKEN_MAX_ACTIVE_PER_USER = 1;

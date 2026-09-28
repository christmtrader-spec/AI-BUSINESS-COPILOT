import "server-only";

/**
 * Email transport configuration resolver — Prompt 29 §8/§17/§18/§100.
 *
 * Single source of truth for whether the SMTP transport is usable. Consumers:
 *  - the SMTP adapter (builds a nodemailer transport),
 *  - the production config validator (startup + preflight),
 *  - readiness (/api/ready, Platform System).
 *
 * Configuration law (§18): a transport is CONFIGURED only when ALL required
 * settings exist together — host + port + from (+ credentials consistency).
 * Checking only EMAIL_SERVER_HOST (the old behavior) is explicitly forbidden.
 *
 * Secret law (§9): the SMTP password is server-only, never logged, never
 * returned, never audited, never sent to the browser. This module returns
 * STATUS + non-secret fields only; `password` is carried in the parsed
 * config for the adapter but never appears in any status/report/DTO.
 */

export type EmailTransportStatus = "CONFIGURED" | "NOT_CONFIGURED" | "INVALID";

export type EmailTransportProblem =
  | "MISSING_HOST"
  | "MISSING_PORT"
  | "INVALID_PORT"
  | "MISSING_FROM"
  | "INVALID_FROM"
  | "PASSWORD_WITHOUT_USER"
  | "USER_WITHOUT_PASSWORD"
  | "INVALID_SECURE_FLAG"
  | "INVALID_TIMEOUT"
  | "INSECURE_MODE_BLOCKED"
  | null;

export type EmailTransportConfig = {
  status: EmailTransportStatus;
  /** Machine-readable first problem (no values, safe for readiness/DTOs). */
  problem: EmailTransportProblem;
  /** True when every required variable is present and syntactically valid. */
  fullyValid: boolean;
  /** Non-secret operational summary (host is operational config, not secret). */
  summary: {
    host: string | null;
    port: number | null;
    from: string | null;
    secure: boolean;
    timeoutMs: number;
    authUsed: boolean;
  };
  /** Parsed values for the adapter. Password NEVER leaves the server. */
  parsed: {
    host: string;
    port: number;
    user: string | null;
    password: string | null;
    from: string;
    secure: boolean;
    timeoutMs: number;
  } | null;
};

const EMAIL_FROM_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const EMAIL_DEFAULT_TIMEOUT_MS = 10_000;
const EMAIL_MIN_TIMEOUT_MS = 1_000;
const EMAIL_MAX_TIMEOUT_MS = 60_000;

/**
 * Resolve email transport configuration from the environment.
 * Never throws; never includes the password (or its length) in the result.
 */
export function resolveEmailTransportConfig(env: {
  EMAIL_SERVER_HOST?: string | undefined;
  EMAIL_SERVER_PORT?: string | undefined;
  EMAIL_SERVER_USER?: string | undefined;
  EMAIL_SERVER_PASSWORD?: string | undefined;
  EMAIL_FROM?: string | undefined;
  EMAIL_SECURE?: string | undefined;
  EMAIL_TIMEOUT_MS?: string | undefined;
  NODE_ENV?: string | undefined;
} = process.env): EmailTransportConfig {
  const host = (env.EMAIL_SERVER_HOST ?? "").trim();
  const portRaw = (env.EMAIL_SERVER_PORT ?? "").trim();
  const user = (env.EMAIL_SERVER_USER ?? "").trim();
  const password = env.EMAIL_SERVER_PASSWORD ?? "";
  const from = (env.EMAIL_FROM ?? "").trim();
  const secureRaw = (env.EMAIL_SECURE ?? "").trim().toLowerCase();
  const timeoutRaw = (env.EMAIL_TIMEOUT_MS ?? "").trim();
  const isProduction = env.NODE_ENV === "production";

  // Nothing configured at all → honest NOT_CONFIGURED (never fake-ready).
  if (!host && !portRaw && !from && !user && !password) {
    return {
      status: "NOT_CONFIGURED",
      problem: null,
      fullyValid: false,
      summary: { host: null, port: null, from: null, secure: false, timeoutMs: EMAIL_DEFAULT_TIMEOUT_MS, authUsed: false },
      parsed: null,
    };
  }

  let problem: EmailTransportProblem = null;
  let port: number | null = null;
  if (!host) problem = problem ?? "MISSING_HOST";
  if (!portRaw) problem = problem ?? "MISSING_PORT";
  else {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) problem = problem ?? "INVALID_PORT";
    else port = n;
  }
  if (!from) problem = problem ?? "MISSING_FROM";
  else if (!EMAIL_FROM_RE.test(from)) problem = problem ?? "INVALID_FROM";

  if (password && !user) problem = problem ?? "PASSWORD_WITHOUT_USER";
  if (user && !password) problem = problem ?? "USER_WITHOUT_PASSWORD";

  // TLS mode (§10): production requires an explicit, certificate-verifying
  // mode. secure=true → implicit TLS (typ. 465). secure=false → STARTTLS is
  // negotiated by nodemailer when the server advertises it; plain-text
  // delivery without any TLS is a development-only posture, so production
  // MUST declare secure explicitly — an unset/absent flag is INVALID there.
  let secure: boolean;
  let secureExplicit: boolean;
  if (secureRaw === "") {
    secure = false;
    secureExplicit = false;
  } else if (secureRaw === "true" || secureRaw === "1") {
    secure = true;
    secureExplicit = true;
  } else if (secureRaw === "false" || secureRaw === "0") {
    secure = false;
    secureExplicit = true;
  } else {
    secure = false;
    secureExplicit = false;
    problem = problem ?? "INVALID_SECURE_FLAG";
  }
  if (isProduction && !secureExplicit) problem = problem ?? "INVALID_SECURE_FLAG";
  if (isProduction && secureExplicit && !secure) {
    // Explicit insecure mode in production is blocked outright (§10): never
    // activate insecure SMTP automatically or by accident in production.
    problem = problem ?? "INSECURE_MODE_BLOCKED";
  }

  let timeoutMs = EMAIL_DEFAULT_TIMEOUT_MS;
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isInteger(n) || n < EMAIL_MIN_TIMEOUT_MS || n > EMAIL_MAX_TIMEOUT_MS) {
      problem = problem ?? "INVALID_TIMEOUT";
    } else {
      timeoutMs = n;
    }
  }

  const valid = problem === null;
  if (!valid) {
    return {
      status: "INVALID",
      problem,
      fullyValid: false,
      // Partial summary is safe (host/port/from are operational values, never secrets).
      summary: { host: host || null, port, from: from || null, secure, timeoutMs, authUsed: Boolean(user) },
      parsed: null,
    };
  }

  return {
    status: "CONFIGURED",
    problem: null,
    fullyValid: true,
    summary: { host, port, from, secure, timeoutMs, authUsed: Boolean(user) },
    parsed: { host, port: port as number, user: user || null, password, from, secure, timeoutMs },
  };
}

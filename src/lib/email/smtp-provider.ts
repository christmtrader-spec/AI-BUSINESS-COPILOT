import "server-only";

/**
 * SMTP adapter — Prompt 29 §7/§10/§11.
 *
 * Provider-agnostic SMTP transport behind the existing EmailProvider
 * boundary: Auth → EmailProvider → SMTP adapter. The authentication module
 * still never talks to a vendor directly (Prompt 18 law preserved).
 *
 * Security/operational laws:
 *  - TLS: uses the `secure` flag from the resolved config. Certificate
 *    verification is NEVER disabled here (no rejectUnauthorized:false
 *    anywhere). Explicit insecure (secure=false) config is blocked at the
 *    config layer in production (see email/config.ts §10).
 *  - Timeout: connection/socket/delivery bounded via nodemailer's
 *    connectionTimeout/greetingTimeout/socketTimeout + an overall
 *    AbortSignal-driven race so a send() can NEVER hang an HTTP request
 *    indefinitely (§11/§21).
 *  - Secrets: the transport is built in-process; the password is passed to
 *    nodemailer only. Errors are reduced to safe classes before logging.
 *  - Single attempt: one send per call, no automatic retries in the HTTP
 *    request path (§21). Future async retry queue is out of scope (§176).
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { EmailMessage, EmailProvider } from "./index";
import { resolveEmailTransportConfig, type EmailTransportConfig } from "./config";

export class EmailDeliveryError extends Error {
  constructor(
    public code:
      | "SMTP_CONNECTION_FAILED"
      | "SMTP_AUTH_FAILED"
      | "SMTP_TIMEOUT"
      | "SMTP_DELIVERY_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** Reduce a raw nodemailer/SMTP error to a safe delivery-error class. */
function classifySmtpError(error: unknown): EmailDeliveryError {
  const err = error as { code?: string; message?: string; command?: string } | null;
  const raw = (err?.message ?? "").slice(0, 200);
  const code = String(err?.code ?? "");
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    /timeout/i.test(raw) ||
    /timeout/i.test(code)
  ) {
    return new EmailDeliveryError("SMTP_TIMEOUT", "SMTP delivery timed out.");
  }
  if (code === "EAUTH" || /auth/i.test(raw) || err?.command === "AUTH") {
    return new EmailDeliveryError("SMTP_AUTH_FAILED", "SMTP authentication failed.");
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "DNSLOOKUP"
  ) {
    return new EmailDeliveryError("SMTP_CONNECTION_FAILED", "SMTP connection failed.");
  }
  return new EmailDeliveryError("SMTP_DELIVERY_FAILED", "SMTP delivery failed.");
}

export class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  private transport: Transporter | null = null;
  private config: EmailTransportConfig;

  constructor(config: EmailTransportConfig) {
    this.config = config;
  }

  private getTransport(): Transporter {
    if (!this.transport) {
      const parsed = this.config.parsed;
      if (!parsed) {
        // Defensive: adapters are only constructed with fullyValid config.
        throw new EmailDeliveryError("SMTP_DELIVERY_FAILED", "SMTP transport is not configured.");
      }
      this.transport = nodemailer.createTransport({
        host: parsed.host,
        port: parsed.port,
        secure: parsed.secure,
        requireTLS: !parsed.secure, // STARTTLS required when not implicit TLS
        auth: parsed.user ? { user: parsed.user, pass: parsed.password ?? "" } : undefined,
        connectionTimeout: parsed.timeoutMs,
        greetingTimeout: parsed.timeoutMs,
        socketTimeout: parsed.timeoutMs,
        // Certificate verification is Node defaults — never tampered with.
        tls: { rejectUnauthorized: true },
      });
    }
    return this.transport;
  }

  async send(message: EmailMessage): Promise<void> {
    const parsed = this.config.parsed;
    if (!parsed) {
      throw new EmailDeliveryError("SMTP_DELIVERY_FAILED", "SMTP transport is not configured.");
    }
    const transport = this.getTransport();
    try {
      await Promise.race([
        transport.sendMail({
          from: parsed.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new EmailDeliveryError("SMTP_TIMEOUT", "SMTP delivery timed out.")),
            parsed.timeoutMs + 2_000,
          ),
        ),
      ]);
    } catch (error) {
      // Normalize node cleanup noise on force-destroyed sockets.
      if (error instanceof EmailDeliveryError) throw error;
      throw classifySmtpError(error);
    }
  }

  /** Idempotent close used by graceful shutdown paths / tests. */
  async close(): Promise<void> {
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // closing must never mask the original delivery outcome
      }
      this.transport = null;
    }
  }
}

/**
 * Build the production SMTP provider from the current environment.
 * Returns null when the transport is NOT_CONFIGURED; throws when INVALID
 * (fail-closed: a half-configured transport must never silently fall back
 * to any pretending transport).
 */
export function smtpProviderFromEnvironment(): SmtpProvider | null {
  const config = resolveEmailTransportConfig();
  if (config.status === "NOT_CONFIGURED") return null;
  if (config.status === "INVALID" || !config.fullyValid || !config.parsed) {
    throw new Error("EMAIL_TRANSPORT_INVALID");
  }
  return new SmtpProvider(config);
}

/**
 * EmailService — provider-agnostic email boundary (Prompt 18 §13).
 *
 * The authentication module NEVER talks to a vendor directly; it calls
 * `getEmailProvider().send(message)`. Wiring a real vendor (SMTP relay,
 * transactional API) means dropping in an adapter that satisfies the
 * EmailProvider interface — no product code changes.
 *
 * Honest behavior matrix (NO fake delivery):
 *  - development: console transport prints a structured, clearly-marked
 *    line INCLUDING the reset link so the flow is testable end-to-end.
 *    Gated on NODE_ENV !== "production" — never active in production.
 *  - production without configured transport: getEmailProvider() throws a
 *    config error BEFORE any user lookup, so password-reset requests fail
 *    uniformly (no account enumeration) and the product never pretends an
 *    email was sent when it was not.
 *
 * Logging law: transport logs may include the recipient address and, in
 * development only, the reset link. They NEVER include passwords.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Masked recipient for logs: a***b@domain.tld */
export function maskAddress(to: string): string {
  const [local, domain] = to.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 2, 1))}${local.slice(-1)}@${domain}`;
}

/** Development-only console transport (NODE_ENV !== "production"). */
const consoleProvider: EmailProvider = {
  name: "console",
  async send(message) {
    // Deliberately loud so dev/QA can copy the reset link from dev.log.
    // Single-line: newlines are flattened so a grep for the marker always
    // yields the FULL body (including any reset link) on one line.
    console.info(
      [
        `[email:console-transport] to=${maskAddress(message.to)}`,
        `subject="${message.subject}"`,
        `body: ${message.text.replace(/\r?\n/g, " | ")}`,
      ].join(" "),
    );
  },
};

/**
 * Production transport placeholder — an adapter for a real SMTP/transactional
 * provider implements EmailProvider and is selected here once credentials
 * exist (see .env.example: EMAIL_* variables are reserved for that adapter).
 * It must NEVER silently swallow a message: no configuration → hard error.
 */
function productionProvider(): EmailProvider {
  const configured = Boolean(process.env.EMAIL_SERVER_HOST);
  if (!configured) {
    throw new Error("EMAIL_TRANSPORT_NOT_CONFIGURED");
  }
  // Future: return new SmtpProvider({...}) — intentionally NOT faked now.
  throw new Error("EMAIL_TRANSPORT_NOT_CONFIGURED");
}

export function getEmailProvider(): EmailProvider {
  if (process.env.NODE_ENV !== "production") return consoleProvider;
  return productionProvider();
}

/* ------------------------- password reset template ------------------------ */

export type PasswordResetEmailInput = {
  to: string;
  recipientName: string | null;
  resetUrl: string;
  minutes: number;
  locale: "en" | "fa";
  appName: string;
};

/** Localized, branded password-reset email (Prompt 18 §30). */
export function buildPasswordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const fa = input.locale === "fa";
  const subject = fa
    ? `${input.appName} — بازنشانی رمز عبور`
    : `${input.appName} — Reset your password`;

  const greeting = fa
    ? `سلام ${input.recipientName ?? ""}`.trim()
    : `Hi ${input.recipientName ?? ""}`.trim();

  const body = fa
    ? [
        `${greeting},`,
        "",
        "درخواست بازنشانی رمز عبور برای حساب شما ثبت شده است.",
        `این پیوند فقط ${input.minutes} دقیقه معتبر است و فقط یک‌بار قابل استفاده است:`,
        input.resetUrl,
        "",
        "اگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید — رمز عبور شما تغییری نکرده است.",
        "برای امنیت بیشتر، هرگز این پیوند را با کسی به اشتراک نگذارید.",
        "",
        `— تیم ${input.appName}`,
      ].join("\n")
    : [
        `${greeting},`,
        "",
        "We received a request to reset the password for your account.",
        `This link is valid for ${input.minutes} minutes and can be used only once:`,
        input.resetUrl,
        "",
        "If you did not request this, you can safely ignore this email — your password has not changed.",
        "Never share this link with anyone.",
        "",
        `— The ${input.appName} team`,
      ].join("\n");

  const securityNote = fa
    ? "نکته امنیتی: رمز عبور خود را هرگز با دیگران به اشتراک نگذارید."
    : "Security note: never share your password with anyone.";

  const html = `<!doctype html><html dir="${fa ? "rtl" : "ltr"}" lang="${fa ? "fa" : "en"}"><body style="font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;background:#f6f7f9;padding:24px;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:28px;">
  <h1 style="font-size:18px;margin:0 0 12px;">${subject}</h1>
  <p style="font-size:14px;line-height:1.7;color:#374151;">${greeting},</p>
  <p style="font-size:14px;line-height:1.7;color:#374151;">${fa
    ? `برای انتخاب رمز عبور جدید روی دکمه زیر بزنید. پیوند ${input.minutes} دقیقه معتبر است و فقط یک‌بار کار می‌کند.`
    : `Click the button below to choose a new password. The link works for ${input.minutes} minutes and only once.`}</p>
  <p style="text-align:center;margin:24px 0;">
    <a href="${input.resetUrl}" style="background:#059669;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;display:inline-block;" rel="noopener">${fa ? "انتخاب رمز عبور جدید" : "Choose a new password"}</a>
  </p>
  <p style="font-size:12px;line-height:1.7;color:#6b7280;word-break:break-all;">${fa ? "اگر دکمه کار نکرد، این نشانی را در مرورگر خود بگشایید:" : "If the button does not work, paste this address into your browser:"}<br>${input.resetUrl}</p>
  <p style="font-size:12px;line-height:1.7;color:#6b7280;">${fa ? "اگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید." : "If you did not request this, you can safely ignore this email."}</p>
  <p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:18px;">${securityNote}</p>
</div>
</body></html>`;

  return { to: input.to, subject, text: body, html };
}

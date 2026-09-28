import type { EmailMessage, EmailProvider } from "./index";

/**
 * TEST-ONLY email provider — Prompt 29 §16.
 *
 * Captures every message in memory so automated tests can assert on subject,
 * locale, reset URL and headers WITHOUT a real SMTP account. Production code
 * paths must NEVER resolve to this provider:
 *  - it lives behind an explicit `EMAIL_PROVIDER=test-memory` opt-in that the
 *    production wiring (email/index.ts getEmailProvider) refuses when
 *    NODE_ENV === "production";
 *  - a static scan in scripts/prompt29-check.mjs fails if the production
 *    path can select it.
 */

export type CapturedEmail = EmailMessage & {
  /** Header-ish metadata for assertions. */
  providerName: string;
  sentAt: string;
};

export class TestMemoryEmailProvider implements EmailProvider {
  readonly name = "test-memory";
  readonly sentMessages: CapturedEmail[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sentMessages.push({
      ...message,
      providerName: this.name,
      sentAt: new Date().toISOString(),
    });
  }

  clear(): void {
    this.sentMessages.length = 0;
  }
}

/** Process-wide singleton so tests can inspect messages sent by API routes. */
const globalForTestEmail = globalThis as unknown as {
  __testMemoryEmailProvider?: TestMemoryEmailProvider;
};

export function getTestMemoryEmailProvider(): TestMemoryEmailProvider {
  if (!globalForTestEmail.__testMemoryEmailProvider) {
    globalForTestEmail.__testMemoryEmailProvider = new TestMemoryEmailProvider();
  }
  return globalForTestEmail.__testMemoryEmailProvider;
}

/**
 * Resolve the test provider ONLY when explicitly opted in outside production.
 * Returns null otherwise (production wiring ignores this path entirely).
 */
export function testMemoryProviderIfAllowed(): TestMemoryEmailProvider | null {
  if (process.env.NODE_ENV === "production") return null;
  if ((process.env.EMAIL_PROVIDER ?? "").trim() === "test-memory") {
    return getTestMemoryEmailProvider();
  }
  return null;
}

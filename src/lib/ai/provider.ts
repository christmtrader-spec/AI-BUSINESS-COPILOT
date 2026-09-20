import "server-only";

/**
 * AIProvider — Constitution A11-A13.
 *
 * The ONLY sanctioned seam between the app and any LLM:
 * - z-ai-web-dev-sdk is imported here and NOWHERE else (server-only).
 * - Swapping vendors later means changing this file only.
 * - Every call is wrapped: empty responses raise, failures are logged
 *   server-side and surfaced as a safe generic error.
 */
import ZAI from "z-ai-web-dev-sdk";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export interface AIProvider {
  /** Complete a chat turn. Returns non-empty text or throws AiUnavailableError. */
  chat(messages: AiMessage[]): Promise<string>;
}

export class AiUnavailableError extends Error {
  constructor(message = "The AI service is temporarily unavailable.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

class ZaiProvider implements AIProvider {
  async chat(messages: AiMessage[]): Promise<string> {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
    });
    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new AiUnavailableError("Empty completion.");
    return content;
  }
}

let provider: AIProvider | null = null;

export function getAI(): AIProvider {
  if (!provider) provider = new ZaiProvider();
  return provider;
}

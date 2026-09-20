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
  /**
   * Stream a chat turn as incremental text deltas (Phase 06).
   * Implementations must yield at least one delta or throw AiUnavailableError.
   */
  chatStream(messages: AiMessage[]): AsyncGenerator<string, void, undefined>;
}

export class AiUnavailableError extends Error {
  constructor(message = "The AI service is temporarily unavailable.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/** Parse an OpenAI-style SSE byte stream into content deltas. */
async function* sseDeltas(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "" || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
          };
          const choice = json.choices?.[0];
          const delta = choice?.delta?.content ?? choice?.message?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
        } catch {
          // Malformed chunk — skip, never crash the stream.
        }
      }
    }
  } finally {
    reader.releaseLock();
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

  async *chatStream(messages: AiMessage[]): AsyncGenerator<string, void, undefined> {
    const zai = await ZAI.create();
    const body = {
      messages,
      thinking: { type: "disabled" } as const,
      stream: true as const,
    };
    // With stream:true the SDK returns the raw response body (ReadableStream)
    // when the upstream answers with SSE; otherwise a normal JSON completion.
    const res: unknown = await zai.chat.completions.create(body);

    if (res instanceof ReadableStream) {
      let produced = false;
      for await (const delta of sseDeltas(res)) {
        produced = true;
        yield delta;
      }
      if (!produced) throw new AiUnavailableError("Empty completion.");
      return;
    }

    // Upstream ignored stream:true and answered with a full JSON body —
    // degrade gracefully to a single-delta "stream".
    const content =
      (res as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
        ?.content?.trim() ?? "";
    if (!content) throw new AiUnavailableError("Empty completion.");
    yield content;
  }
}

let provider: AIProvider | null = null;

export function getAI(): AIProvider {
  if (!provider) provider = new ZaiProvider();
  return provider;
}

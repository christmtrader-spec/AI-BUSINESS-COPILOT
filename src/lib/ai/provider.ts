import "server-only";

/**
 * AIProvider — Constitution A11-A13.
 *
 * The ONLY sanctioned seam between the app and any LLM:
 * - z-ai-web-dev-sdk is imported here and NOWHERE else (server-only).
 * - Swapping vendors later means changing this file only.
 * - Every call is wrapped: empty responses raise, failures are logged
 *   server-side and surfaced as a safe generic error.
 *
 * Prompt 21 — provider usage abstraction (§15): implementations may surface
 * a NORMALIZED usage object (inputTokens/outputTokens/totalTokens) when the
 * provider genuinely reports one. Usage is never fabricated: when the
 * provider exposes nothing, `usage` stays null and the caller records
 * "unknown" (§14). The shape is provider-independent — billing logic never
 * depends on a vendor SDK field name.
 */
import ZAI from "z-ai-web-dev-sdk";
import type { AiProviderUsage } from "@/lib/billing/usage";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiChatResult = {
  text: string;
  /** Normalized provider usage — null when the provider reports none. */
  usage: AiProviderUsage | null;
  /**
   * Model identifier EXACTLY as reported by the provider — null when the
   * transport exposes nothing trustworthy (Prompt 26 §81: never invented).
   */
  model: string | null;
};

export interface AIProvider {
  /** Complete a chat turn. Returns non-empty text (+usage when reported) or throws AiUnavailableError. */
  chat(messages: AiMessage[]): Promise<AiChatResult>;
  /**
   * Stream a chat turn as incremental text deltas (Phase 06).
   * Implementations must yield at least one delta or throw AiUnavailableError.
   * `onUsage` (optional) receives normalized provider usage — and the
   * provider-reported model identifier, when the transport genuinely
   * exposes one — at most once per stream, never with fabricated values.
   */
  chatStream(
    messages: AiMessage[],
    onUsage?: (usage: AiProviderUsage, model: string | null) => void,
  ): AsyncGenerator<string, void, undefined>;
}

export class AiUnavailableError extends Error {
  constructor(message = "The AI service is temporarily unavailable.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/** Honest model extraction — ONLY a non-empty string the provider sent (§81). */
function extractModel(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { model?: unknown }).model;
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128
    ? value.trim()
    : null;
}

/** Normalize an OpenAI-style usage object; null when nothing usable (§14). */
function normalizeUsage(raw: unknown): AiProviderUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = u[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return null;
  };
  const inputTokens = pick("prompt_tokens", "input_tokens", "inputTokens");
  const outputTokens = pick("completion_tokens", "output_tokens", "outputTokens");
  const totalTokens = pick("total_tokens", "totalTokens");
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Parse an OpenAI-style SSE byte stream into content deltas. A final frame
 * carrying a usage object is surfaced through `onUsage` exactly once —
 * only when the upstream genuinely includes it (never fabricated).
 */
async function* sseDeltas(
  stream: ReadableStream<Uint8Array>,
  onUsage?: (usage: AiProviderUsage, model: string | null) => void,
): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usageSeen = false;
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
            usage?: unknown;
            model?: unknown;
          };
          const choice = json.choices?.[0];
          const delta = choice?.delta?.content ?? choice?.message?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
          if (!usageSeen && json.usage !== undefined) {
            const normalized = normalizeUsage(json.usage);
            if (normalized) {
              usageSeen = true;
              onUsage?.(normalized, extractModel(json));
            }
          }
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
  async chat(messages: AiMessage[]): Promise<AiChatResult> {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
    });
    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) throw new AiUnavailableError("Empty completion.");
    // Record ONLY what the provider actually reported (§14) — the field is
    // optional on the wire and stays null when absent.
    const usage = normalizeUsage((completion as { usage?: unknown }).usage);
    const model = extractModel(completion);
    return { text: content, usage, model };
  }

  async *chatStream(
    messages: AiMessage[],
    onUsage?: (usage: AiProviderUsage, model: string | null) => void,
  ): AsyncGenerator<string, void, undefined> {
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
      for await (const delta of sseDeltas(res, onUsage)) {
        produced = true;
        yield delta;
      }
      if (!produced) throw new AiUnavailableError("Empty completion.");
      return;
    }

    // Upstream ignored stream:true and answered with a full JSON body —
    // degrade gracefully to a single-delta "stream".
    const payload = res as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
      model?: unknown;
    };
    const content = payload?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) throw new AiUnavailableError("Empty completion.");
    const usage = normalizeUsage(payload?.usage);
    if (usage) onUsage?.(usage, extractModel(payload));
    yield content;
  }
}

let provider: AIProvider | null = null;

export function getAI(): AIProvider {
  if (!provider) provider = new ZaiProvider();
  return provider;
}

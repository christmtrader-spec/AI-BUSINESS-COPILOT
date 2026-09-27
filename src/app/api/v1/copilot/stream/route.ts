/**
 * POST /api/v1/copilot/stream — streaming variant of the copilot (Phase 06).
 *
 * Deterministic-first contract is unchanged (A11-A13): the model receives a
 * server-computed snapshot and narrates; it never computes. The only
 * difference is transport — Server-Sent Events:
 *
 *   data: {"meta":{...}}          first event (snapshot metadata)
 *   data: {"delta":"..."}         incremental answer text
 *   data: {"done":true}           terminal event on success
 *   data: {"error":{"code","message"}}  terminal event on mid-stream failure
 *
 * All auth / permission / BILLING GATE / rate-limit / grounding / USAGE
 * METERING work happens BEFORE the stream is created, so every pre-stream
 * failure (including 422 USAGE_LIMIT_REACHED — Prompt 21 §23) is a normal
 * JSON envelope with the correct status code.
 *
 * Prompt 21 metering semantics (§45 — stream-aware, no double counting):
 * - metered ONCE per logical operation (never per chunk);
 * - provider failure / stream abort with NO deltas → usage RELEASED;
 * - at least one delta produced → the provider accepted the operation and
 *   the charge stands (user abort included — partial content was delivered);
 * - provider-reported token usage is recorded when the transport exposes it.
 *
 * Audit is written when the stream closes (completed / aborted / failed
 * status recorded).
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { copilotAskSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import {
  assertFeatureAccess,
  meterAiOperation,
  recordAiTokenUsage,
  releaseAiOperation,
} from "@/lib/billing";
import { attributeAiCost } from "@/lib/ai/cost/ledger";
import { assertAiCostGuard } from "@/lib/ai/cost/governance";
import { buildCopilotGrounding } from "@/lib/ai/snapshot";
import { AiUnavailableError, getAI, type AiMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (req: NextRequest) => {
  const authCtx = await getAuthContext(req);
  requirePermission(authCtx, "copilot:use");

  // Billing gate — BUG FIX (Prompt 21): the streaming endpoint previously
  // skipped the AI_COPILOT entitlement gate that the chat endpoint had,
  // letting a boolean-gated-out business still reach the provider through
  // this path. Both transports now enforce the SAME pipeline (§44).
  await assertFeatureAccess(authCtx.businessId, "AI_COPILOT");

  const rl = rateLimit(`copilot:${authCtx.userId}:${authCtx.businessId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many questions. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await copilotAskSchema.parse(await req.json());

  // Prompt 26 §70 — request-level COST GUARD at the AI execution boundary.
  // Default OFF; never evaluated from React; fail-open on monitoring failure.
  const guard = await assertAiCostGuard({ businessId: authCtx.businessId });
  if (guard.blocked) {
    throw new ApiError(429, "AI_COST_GUARD_BLOCKED", "AI usage is temporarily paused by a cost protection policy.", {
      reasons: guard.reasons,
    });
  }

  // Usage metering BEFORE the stream opens (§44). A quota rejection is a
  // plain structured 422 JSON response — the stream never starts.
  const requestId = input.requestId ?? crypto.randomUUID();
  await meterAiOperation(authCtx.businessId, requestId, {
    meta: { transport: "stream", actorId: authCtx.userId },
  });

  const grounding = await buildCopilotGrounding({
    businessId: authCtx.businessId,
    business: {
      name: authCtx.business.name,
      currencyCode: authCtx.business.currencyCode,
      currencySymbol: authCtx.business.currencySymbol,
      decimalPrecision: authCtx.business.decimalPrecision,
      locale: authCtx.business.locale,
      timezone: authCtx.business.timezone,
    },
    days: input.days,
    uiLocale: authCtx.business.locale === "fa" ? "fa" : "en",
  });

  const history: AiMessage[] = input.history
    .slice(-6)
    .map((m): AiMessage => ({ role: m.role, content: m.content }));

  const messages: AiMessage[] = [
    { role: "system", content: grounding.systemPrompt },
    ...history,
    { role: "user", content: input.question },
  ];

  const encoder = new TextEncoder();
  const question = input.question;
  const businessId = authCtx.businessId;
  const actorId = authCtx.userId;
  const ip = req.headers.get("x-forwarded-for");
  const userAgent = req.headers.get("user-agent");
  const abortSignal = req.signal;

  let answerChars = 0;
  let status: "completed" | "aborted" | "failed" = "completed";
  // Prompt 21 §45: the reservation is RELEASED only when the provider never
  // delivered anything (failure/abort before the first delta).
  let producedAnyDelta = false;
  let providerUsage: import("@/lib/billing").AiProviderUsage | null = null;
  let providerModel: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        send({ meta: { ...grounding.meta, requestId } });
        for await (const delta of getAI().chatStream(messages, (usage, model) => {
          providerUsage = usage;
          providerModel = model;
        })) {
          if (abortSignal.aborted) {
            status = "aborted";
            break;
          }
          producedAnyDelta = true;
          answerChars += delta.length;
          send({ delta });
        }
        if (status === "completed") send({ done: true });
      } catch (error) {
        if (abortSignal.aborted) {
          status = "aborted";
        } else if (error instanceof AiUnavailableError) {
          console.error("[copilot/stream] AI unavailable:", error.message);
          status = "failed";
          try {
            send({ error: { code: "AI_UNAVAILABLE", message: "The AI service is temporarily unavailable." } });
          } catch {
            // client already gone
          }
        } else {
          console.error("[copilot/stream] failed:", error);
          status = "failed";
          try {
            send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
          } catch {
            // client already gone
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }

        // Reconcile the metering reservation (§20/§21/§45/§49):
        // - nothing delivered (provider never accepted / aborted empty) →
        //   release so the user is not charged for a failed attempt;
        // - any delta delivered → the charge stands.
        if (!producedAnyDelta) {
          await releaseAiOperation(businessId, requestId, {
            reason: status === "aborted" ? "stream-aborted-empty" : status === "failed" ? "stream-failed" : "no-output",
          });
        } else {
          if (providerUsage) {
            await recordAiTokenUsage(businessId, requestId, providerUsage, {
              provider: "z-ai",
              ...(providerModel ? { model: providerModel } : {}),
            });
          }
          // Prompt 26 — COST ATTRIBUTION (fail-safe, §29/§30): the response
          // is already delivered; attribution MUST never break it. With no
          // provider token metadata the cost is honestly UNKNOWN
          // (TOKENS_MISSING) and reconciliation may revisit it later.
          void attributeAiCost({
            businessId,
            requestId,
            provider: "z-ai",
            model: providerModel,
            usage: providerUsage
              ? {
                  inputTokens: providerUsage.inputTokens ?? null,
                  outputTokens: providerUsage.outputTokens ?? null,
                  totalTokens: providerUsage.totalTokens ?? null,
                }
              : null,
          });
        }

        // Audit on close — never break the response, but be loud on failure.
        void audit({
          businessId,
          actorId,
          action: "copilot.query",
          entityType: "Copilot",
          entityId: null,
          after: {
            question: question.slice(0, 200),
            days: grounding.meta.days,
            transport: "stream",
            status,
            chars: answerChars,
            requestId,
          },
          ip,
          userAgent,
        });
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});

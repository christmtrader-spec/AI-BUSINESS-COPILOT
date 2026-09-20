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
 * All auth / permission / rate-limit / grounding work happens BEFORE the
 * stream is created, so every pre-stream failure is a normal JSON envelope
 * with the correct status code. Audit is written when the stream closes
 * (completed / aborted / failed status recorded).
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { copilotAskSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { buildCopilotGrounding } from "@/lib/ai/snapshot";
import { AiUnavailableError, getAI, type AiMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (req: NextRequest) => {
  const authCtx = await getAuthContext(req);
  requirePermission(authCtx, "copilot:use");

  const rl = rateLimit(`copilot:${authCtx.userId}:${authCtx.businessId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many questions. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await copilotAskSchema.parse(await req.json());

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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        send({ meta: grounding.meta });
        for await (const delta of getAI().chatStream(messages)) {
          if (abortSignal.aborted) {
            status = "aborted";
            break;
          }
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

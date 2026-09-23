/**
 * POST /api/v1/copilot — read-only natural-language Q&A (Phase 05).
 *
 * Deterministic-first (A11-A13): the model receives a snapshot where every
 * monetary figure is computed by THIS server (lib/reports.ts) and
 * pre-formatted with the business currency config. The model narrates;
 * it never computes and the client never supplies financial data.
 *
 * Guards:
 * - auth + membership + `copilot:use` (VIEWER excluded per RBAC matrix)
 * - billing gate: AI_COPILOT boolean entitlement (Prompt 20, fresh §111)
 * - USAGE METERING (Prompt 21): one accepted execution = 1 × AI_MESSAGES +
 *   1 × AI_REQUESTS, metered atomically BEFORE the provider call and
 *   RELEASED when the provider never accepts (§20/§49). Quota exhaustion
 *   returns a structured 422 USAGE_LIMIT_REACHED (§23) — never a 500.
 * - rate limit: 10 questions / minute / user (A14) — runs BEFORE metering
 *   so rate-limited clients consume nothing.
 * - audited: copilot.query (question truncated to 200 chars — never the
 *   full prompt/response, §103)
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { copilotAskSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess, meterAiOperation, recordAiTokenUsage, releaseAiOperation } from "@/lib/billing";
import { buildCopilotGrounding } from "@/lib/ai/snapshot";
import { AiUnavailableError, getAI, type AiChatResult, type AiMessage } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "copilot:use");

  // Billing gate (§36): AI_COPILOT boolean entitlement — server-side,
  // fresh read (§111). Quota enforcement happens in the metering step below.
  await assertFeatureAccess(ctx.businessId, "AI_COPILOT");

  const rl = rateLimit(`copilot:${ctx.userId}:${ctx.businessId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many questions. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, copilotAskSchema);

  // Usage metering (Prompt 21 §44 pipeline: authenticate → authorize →
  // entitlement → quota → meter → call AI → finalize). The server decides
  // the quantity (§59) — the client cannot inject usage or limits; it may
  // only supply a UUID requestId that makes a retry idempotent (§17).
  const requestId = input.requestId ?? crypto.randomUUID();
  const metering = await meterAiOperation(ctx.businessId, requestId, {
    meta: { transport: "chat", actorId: ctx.userId },
  });

  const grounding = await buildCopilotGrounding({
    businessId: ctx.businessId,
    business: {
      name: ctx.business.name,
      currencyCode: ctx.business.currencyCode,
      currencySymbol: ctx.business.currencySymbol,
      decimalPrecision: ctx.business.decimalPrecision,
      locale: ctx.business.locale,
      timezone: ctx.business.timezone,
    },
    days: input.days,
    uiLocale: ctx.business.locale === "fa" ? "fa" : "en",
  });

  // Replay a bounded slice of the conversation for follow-up questions.
  // The system prompt is always FIRST and freshly rebuilt (fresh data,
  // never trust an assistant turn to carry authoritative numbers).
  const history: AiMessage[] = input.history
    .slice(-6)
    .map((m): AiMessage => ({ role: m.role, content: m.content }));

  const messages: AiMessage[] = [
    { role: "system", content: grounding.systemPrompt },
    ...history,
    { role: "user", content: input.question },
  ];

  let result: AiChatResult;
  try {
    result = await getAI().chat(messages);
  } catch (error) {
    // Provider never accepted the operation → release the reservation
    // (§20/§49: infrastructure failure before acceptance = no final usage).
    await releaseAiOperation(ctx.businessId, requestId, {
      reason: error instanceof AiUnavailableError ? "provider-unavailable" : "provider-error",
    });
    if (error instanceof AiUnavailableError) {
      console.error("[copilot] AI unavailable:", error.message);
      throw new ApiError(503, "AI_UNAVAILABLE", "The AI service is temporarily unavailable.");
    }
    throw error;
  }

  // Success: the charge stands. Record provider token usage when genuinely
  // reported (§14) — never fabricated.
  if (result.usage) {
    await recordAiTokenUsage(ctx.businessId, requestId, result.usage, { provider: "z-ai" });
  }

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "copilot.query",
    entityType: "Copilot",
    entityId: null,
    after: { question: input.question.slice(0, 200), days: grounding.meta.days, requestId },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return ok({
    answer: result.text,
    meta: grounding.meta,
    requestId,
    usage: metering.metrics,
  });
});

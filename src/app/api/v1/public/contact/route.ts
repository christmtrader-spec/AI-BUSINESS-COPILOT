/**
 * POST /api/v1/public/contact — Prompt 25 §27-§29.
 *
 * The minimal Contact-Sales capture for ENTERPRISE (and for visitors when
 * payments are unavailable). Deliberately NOT a CRM (§28): four fields,
 * generic success response (never confirms storage), IP rate-limited, and
 * a honeypot field that silently swallows bot submissions.
 *
 * Privacy (§29): stores ONLY what is needed to reply (name/email/company/
 * message + the UI locale). No business financial data, no tracking. The
 * same retention statement is documented in docs/marketing/public-pricing.md.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  company: z.string().trim().max(120).optional().nullable().transform((v) => v || null),
  message: z.string().trim().min(1).max(2000),
  locale: z.enum(["en", "fa"]).default("en"),
  // Honeypot (§75 — no dark patterns, just quiet bot control): any VALUE is
  // accepted by the schema so a bot gets a normal response, and the handler
  // silently discards it — never a validation error that tips bots off.
  website: z.string().max(200).optional().nullable(),
});

export const POST = route(async (req: NextRequest) => {
  const ip = getClientIp(req);
  const rl = rateLimit(`public-contact:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, contactSchema);

  // Honeypot filled → pretend success, store nothing (bots move on).
  if (input.website) {
    return ok({ received: true });
  }

  await db.contactLead.create({
    data: {
      name: input.name,
      email: input.email,
      company: input.company,
      message: input.message,
      locale: input.locale,
    },
  });

  // Generic reassurance — never leaks whether/where leads are stored (§29).
  return ok({ received: true }, 201);
});

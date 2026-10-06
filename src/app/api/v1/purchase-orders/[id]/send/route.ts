/**
 * Prompt 41 — POST /api/v1/purchase-orders/[id]/send (§16).
 * INTERNAL procurement status transition DRAFT → SENT (§15). It does NOT
 * mean an email/SMS/webhook was sent and no external delivery is claimed.
 * Requires ≥1 line (§37) and a still-valid supplier (§38). No financial or
 * inventory writes (§4/§110).
 */
import { transitionRoute } from "../transition";

export const dynamic = "force-dynamic";
export const POST = transitionRoute("send");

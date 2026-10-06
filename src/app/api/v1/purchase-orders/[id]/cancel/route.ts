/**
 * Prompt 41 — POST /api/v1/purchase-orders/[id]/cancel (§19/§41).
 * DRAFT/SENT/CONFIRMED → CANCELLED; CLOSED/CANCELLED cannot be cancelled.
 * Cancellation is terminal and transactional; it reverses nothing because a
 * purchase order never posted inventory or financial transactions (§4).
 */
import { transitionRoute } from "../transition";

export const dynamic = "force-dynamic";
export const POST = transitionRoute("cancel");

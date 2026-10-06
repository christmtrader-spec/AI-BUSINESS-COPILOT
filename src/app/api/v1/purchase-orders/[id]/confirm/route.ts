/**
 * Prompt 41 — POST /api/v1/purchase-orders/[id]/confirm (§17).
 * SENT → CONFIRMED: the document becomes commercially confirmed internally.
 * It does NOT mean goods arrived, inventory increased, an invoice was
 * received, an expense was recorded or a payment was made (§112 pins this).
 */
import { transitionRoute } from "../transition";

export const dynamic = "force-dynamic";
export const POST = transitionRoute("confirm");

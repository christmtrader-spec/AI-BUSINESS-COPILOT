/**
 * Prompt 41 — POST /api/v1/purchase-orders/[id]/close (§18).
 * CONFIRMED → CLOSED: the procurement document is administratively complete.
 * It does NOT mean "received" — no inventory mutation, no expense, no
 * payment, no stock adjustment (§113 pins this). The status is never
 * called "Received" anywhere in the product (§203).
 */
import { transitionRoute } from "../transition";

export const dynamic = "force-dynamic";
export const POST = transitionRoute("close");

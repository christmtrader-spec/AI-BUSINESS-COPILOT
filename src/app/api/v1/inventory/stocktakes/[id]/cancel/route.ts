/**
 * Prompt 40 — POST /api/v1/inventory/stocktakes/[id]/cancel
 * Dedicated server-authoritative transition (§8/§9). data:write (§53).
 */
import { transitionRoute } from "../transition";

export const dynamic = "force-dynamic";

export const POST = transitionRoute("cancel");

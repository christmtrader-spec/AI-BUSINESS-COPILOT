/**
 * Internal cost-operator authorization boundary — Prompt 26 §170-§171.
 *
 * Prompt 26 does NOT build a Platform Admin layer. Every cost MUTATION
 * (rate create/verify/deactivate, reconciliation apply) and every internal
 * economics READ must be an explicitly authorized internal caller — never
 * anonymous, never a tenant, never a customer admin.
 *
 * Temporary mechanism (to be mapped onto Platform permissions in Prompt 28):
 * - Server-side scripts/service code may call cost services directly (the
 *   module boundary IS the authorization — there is no public route).
 * - Any future HTTP exposure MUST funnel through assertInternalOperator()
 *   with the AI_COST_OPERATOR_TOKEN check below; the token is compared in
 *   constant time and NEVER logged (§74).
 *
 * Deliberately NO tenant-facing endpoints exist for:
 *   rate listing, cost records, margin, anomalies, reconciliation.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export class InternalAuthorizationError extends Error {
  constructor(message = "Internal cost operator authorization required.") {
    super(message);
    this.name = "InternalAuthorizationError";
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Assert the caller is an internal cost operator. Throws
 * InternalAuthorizationError otherwise. Callers that cannot present the
 * token (i.e. all tenants/customers) are rejected — 403-equivalent.
 */
export function assertInternalOperator(presentedToken: string | null | undefined): void {
  const expected = process.env.AI_COST_OPERATOR_TOKEN?.trim();
  if (!expected) {
    // No operator token configured → no HTTP caller may mutate cost state.
    // (Server-internal scripts pass through assertInternalServiceCall below.)
    throw new InternalAuthorizationError();
  }
  if (!presentedToken || !constantTimeEquals(presentedToken, expected)) {
    throw new InternalAuthorizationError();
  }
}

/**
 * Server-internal callers (harnesses, cron, future P28 admin services) that
 * run INSIDE the trusted server process boundary. This is explicit and
 * auditable by import — it must never be reachable from a request handler
 * without assertInternalOperator() first.
 */
export function assertInternalServiceCall(): void {
  // Marker method — exists to make the trusted-boundary import explicit and
  // greppable. See docs/ai/ai-cost-governance.md §authorization.
}

/**
 * GET /api/v1/platform/system — safe readiness view (§59/§60/§85/§122).
 *
 * Every component reports ONLY: READY | NOT_CONFIGURED | BLOCKED | DISABLED.
 * NO secrets, NO raw environment dump (§85) — statuses are derived facts
 * from configuration/config modules/database state. Prompt-27 trust
 * configuration is REUSED (publicPlatformConfigSummary), never duplicated
 * (§60). Retention policy remains honestly reported as not configured
 * (§67/§118 — no invented periods).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { publicPlatformConfigSummary } from "@/lib/legal/public-config";
import { getAiCostHealth } from "@/lib/ai/cost/economics";
import { listProviders } from "@/lib/payments/registry";
import { getAiCostConfig } from "@/lib/ai/cost/config";
import { getTrialConfig } from "@/lib/billing/trial-config";

export const dynamic = "force-dynamic";

type Status = "READY" | "NOT_CONFIGURED" | "BLOCKED" | "DISABLED";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:system:read");

  // Database + migration state (no connection strings).
  let database: Status = "BLOCKED";
  let migrationsApplied = 0;
  let migrationsPending = 0;
  try {
    migrationsPending = await db.$queryRawUnsafe<number>(`
      SELECT COUNT(*) as c FROM "_prisma_migrations" WHERE finished_at IS NULL
    `).then((rows: unknown) => {
      const arr = rows as Array<{ c: number | bigint }>;
      return Number(arr[0]?.c ?? 0);
    });
    migrationsApplied = await db.$queryRawUnsafe<number>(`
      SELECT COUNT(*) as c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `).then((rows: unknown) => {
      const arr = rows as Array<{ c: number | bigint }>;
      return Number(arr[0]?.c ?? 0);
    });
    database = "READY";
  } catch {
    database = "BLOCKED";
  }

  // Payment readiness — honest, capability-derived (§123).
  const providers = listProviders();
  const activePaymentProviders = providers.filter((p) => p.usable && p.mode === "production");
  const paymentStatus: Status =
    activePaymentProviders.length > 0 ? "READY" : "NOT_CONFIGURED";

  // AI provider + rate configuration (§124).
  let aiProviderConfigured = false;
  try {
    const { getAI } = await import("@/lib/ai/provider");
    const ai = getAI();
    aiProviderConfigured = !!ai;
  } catch {
    aiProviderConfigured = false;
  }
  const health = await getAiCostHealth(30);
  const aiRateStatus: Status =
    health.verifiedRates > 0 ? "READY" : "NOT_CONFIGURED";

  const costConfig = getAiCostConfig();
  const guardStatus: Status = costConfig.guardEnabled ? "READY" : "DISABLED";

  // Trust configuration (Prompt 27 reuse, §60/§122).
  const trust = publicPlatformConfigSummary();
  const trustStatus = (s: string): Status =>
    s === "CONFIGURED" ? "READY" : s === "INVALID" ? "BLOCKED" : "NOT_CONFIGURED";

  // Trial configuration state.
  const trialCfg = getTrialConfig();
  const trialStatus: Status = trialCfg.enabled ? "READY" : "DISABLED";

  return platformOk({
    generatedAt: new Date().toISOString(),
    components: [
      { key: "database", status: database, detail: "connectivity" },
      {
        key: "migrations",
        status: migrationsPending === 0 ? "READY" : "BLOCKED",
        detail: `${migrationsApplied} applied / ${migrationsPending} pending`,
      },
      { key: "payments", status: paymentStatus, detail: activePaymentProviders.length > 0 ? "production provider active" : "no production provider active (sandbox only)" },
      { key: "aiProvider", status: aiProviderConfigured ? "READY" : "NOT_CONFIGURED", detail: null },
      { key: "aiCostRates", status: aiRateStatus, detail: `${health.verifiedRates} verified production-eligible rate(s)` },
      { key: "aiCostGuard", status: guardStatus, detail: costConfig.guardEnabled ? "enabled" : "disabled (default)" },
      { key: "publicUrl", status: trustStatus(trust.publicBaseUrl.status), detail: null },
      { key: "https", status: trustStatus(trust.httpsOrigin.status), detail: null },
      { key: "legalIdentity", status: trustStatus(trust.legalIdentity.status), detail: null },
      { key: "supportContact", status: trustStatus(trust.supportContact.status), detail: null },
      { key: "privacyContact", status: trustStatus(trust.privacyContact.status), detail: null },
      { key: "legalContact", status: trustStatus(trust.legalContact.status), detail: null },
      { key: "securityContact", status: trustStatus(trust.securityContact.status), detail: null },
      { key: "trials", status: trialStatus, detail: trialCfg.enabled ? `${trialCfg.trialDays}d configured` : "disabled by configuration" },
      {
        key: "retentionPolicy",
        // §67/§118 — honest: no automatic deletion policy is configured.
        status: "NOT_CONFIGURED" as Status,
        detail: "CURRENTLY NOT EXPLICITLY CONFIGURED",
      },
      {
        key: "platformAuditRetention",
        status: "NOT_CONFIGURED" as Status,
        detail: "CURRENTLY NOT EXPLICITLY CONFIGURED",
      },
    ],
  });
});

/**
 * GET /api/v1/platform/system — safe readiness view (§59/§60/§85/§122).
 *
 * Prompt 29 §43: readiness computation is SHARED with /api/ready via
 * src/lib/observability/readiness.ts — this route consumes the same result
 * and adds operator-level detail. No duplicated readiness logic.
 *
 * Every component reports ONLY a status word plus safe detail strings
 * (counts, never values). NO secrets, NO raw environment dump (§85).
 * Prompt-27 trust configuration is REUSED (publicPlatformConfigSummary),
 * never duplicated (§60). Retention policy remains honestly reported as not
 * configured (§67/§118 — no invented periods).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { publicPlatformConfigSummary } from "@/lib/legal/public-config";
import { getAiCostConfig } from "@/lib/ai/cost/config";
import { getTrialConfig } from "@/lib/billing/trial-config";
import { listProviders } from "@/lib/payments/registry";
import { computeReadiness, type ReadinessComponent } from "@/lib/observability/readiness";
import { getProductionConfigReport } from "@/lib/config/production";

export const dynamic = "force-dynamic";

type Status = "READY" | "NOT_CONFIGURED" | "BLOCKED" | "DISABLED";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:system:read");

  const r = await computeReadiness();

  // Detailed AI-cost/guard/trial state (unchanged semantics).
  const costConfig = getAiCostConfig();
  const guardStatus: Status = costConfig.guardEnabled ? "READY" : "DISABLED";
  const trialCfg = getTrialConfig();
  const trialStatus: Status = trialCfg.enabled ? "READY" : "DISABLED";

  // Payment capability detail (honest, capability-derived, §123).
  const providers = listProviders();
  const activePaymentProviders = providers.filter((p) => p.usable && p.mode === "production");

  // Trust configuration (Prompt 27 reuse, §60/§122).
  const trust = publicPlatformConfigSummary();
  const trustStatus = (s: string): Status =>
    s === "CONFIGURED" ? "READY" : s === "INVALID" ? "BLOCKED" : "NOT_CONFIGURED";

  // Prompt 30 §186 — identity-security posture (same shared report, §43).
  const report = getProductionConfigReport();

  const map = (c: ReadinessComponent): Status =>
    c === "READY" || c === "PARTIAL"
      ? "READY"
      : c === "DISABLED"
        ? "DISABLED"
        : c === "NOT_CONFIGURED" || c === "STALE" || c === "REQUIRES_REVIEW"
          ? "NOT_CONFIGURED"
          : "BLOCKED";

  const lastBackup = r.internal.lastBackup;
  const drill = r.internal.lastRestoreDrill;

  return platformOk({
    generatedAt: new Date().toISOString(),
    overall: r.ready,
    version: r.version,
    components: [
      { key: "database", status: map(r.components.database), detail: "connectivity" },
      {
        key: "migrations",
        status: map(r.components.migrations),
        detail: `${r.internal.migrationsApplied} applied / ${r.internal.migrationsPending} pending`,
      },
      {
        key: "configuration",
        status: map(r.components.configuration),
        detail: r.internal.blockingProblems.length === 0 ? "mandatory production config satisfied" : `${r.internal.blockingProblems.length} blocking problem(s)`,
      },
      {
        key: "email",
        status: map(r.components.email),
        detail:
          r.components.email === "READY"
            ? "SMTP transport configured"
            : r.components.email === "BLOCKED"
              ? "SMTP configuration invalid"
              : "EMAIL_TRANSPORT_NOT_CONFIGURED",
      },
      { key: "payments", status: map(r.components.payments), detail: activePaymentProviders.length > 0 ? "production provider active" : "no production provider active (sandbox only)" },
      { key: "aiProvider", status: r.components.aiCostRates === "READY" ? ("READY" as Status) : ("NOT_CONFIGURED" as Status), detail: null },
      {
        key: "aiCostRates",
        status: map(r.components.aiCostRates),
        detail: r.components.aiCostRates === "READY" ? "verified production-eligible rate(s) exist" : "no verified production rate (0)",
      },
      { key: "aiCostGuard", status: guardStatus, detail: costConfig.guardEnabled ? "enabled" : "disabled (default)" },
      { key: "publicUrl", status: trustStatus(trust.publicBaseUrl.status), detail: null },
      { key: "https", status: trustStatus(trust.httpsOrigin.status), detail: null },
      { key: "legalIdentity", status: trustStatus(trust.legalIdentity.status), detail: null },
      { key: "supportContact", status: trustStatus(trust.supportContact.status), detail: null },
      { key: "privacyContact", status: trustStatus(trust.privacyContact.status), detail: null },
      { key: "legalContact", status: trustStatus(trust.legalContact.status), detail: null },
      { key: "securityContact", status: trustStatus(trust.securityContact.status), detail: null },
      {
        key: "legalReview",
        status: r.components.legal === "READY" ? ("READY" as Status) : ("NOT_CONFIGURED" as Status),
        detail: r.components.legal === "READY" ? "legal review completed" : "REQUIRES_REVIEW (effectiveDate pending)",
      },
      { key: "trials", status: trialStatus, detail: trialCfg.enabled ? `${trialCfg.trialDays}d configured` : "disabled by configuration" },
      {
        key: "backups",
        status: map(r.components.backups),
        detail:
          lastBackup && lastBackup.exists
            ? `last backup ${lastBackup.verified ? "verified" : "UNVERIFIED"}${lastBackup.ageHours !== null ? `, ~${lastBackup.ageHours}h old` : ""}`
            : "no verified backup manifest found",
      },
      {
        key: "restoreDrill",
        status: map(r.components.restoreDrill),
        detail:
          drill && drill.ranAt
            ? `last drill ${drill.result}${drill.ageDays !== null ? `, ~${Math.round(drill.ageDays)}d ago` : ""}`
            : "RESTORE_DRILL_NOT_RUN",
      },
      {
        // Prompt 30 §186 — MFA capability state (safe: never key material).
        key: "mfa",
        status: map(r.components.mfa),
        detail:
          report.identitySecurity.mfaState === "DISABLED"
            ? "MFA_ENABLED=false (capability off)"
            : report.identitySecurity.mfaState === "ENABLED_CONFIGURED"
              ? "ENABLED_CONFIGURED (encryption key valid)"
              : "BLOCKED_CONFIGURATION (encryption key invalid/missing)",
      },
      {
        // Prompt 30 §186 — email-verification mode (safe mode name only).
        key: "emailVerification",
        status: map(r.components.emailVerification),
        detail: `AUTH_EMAIL_VERIFICATION_MODE=${report.identitySecurity.emailVerificationState}`,
      },
      {
        // Prompt 31 §297/§305 — portability storage posture (NO paths).
        key: "portabilityStorage",
        status: map(r.components.portabilityStorage),
        detail:
          r.components.portabilityStorage === "READY"
            ? "export/import storage writable, non-public"
            : r.components.portabilityStorage === "BLOCKED"
              ? "PORTABILITY_STORAGE_INVALID (root inside a web-served directory)"
              : "PORTABILITY_STORAGE_NOT_WRITABLE",
      },
      {
        // Prompt 32 §380/§446 — notification platform posture (safe status
        // only: catalog health + email transport; NO paths, NO internals).
        key: "notifications",
        status: map(r.components.notifications),
        detail:
          r.components.notifications === "READY"
            ? "catalog healthy + email transport configured"
            : r.components.notifications === "PARTIAL"
              ? "catalog healthy — email transport unconfigured (in-app still works)"
              : "catalog validation failed",
      },
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

import "server-only";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";

/**
 * Shared readiness service — Prompt 29 §39-43, §90-92, §104-107, §171-172.
 *
 * ONE authoritative readiness computation, consumed by:
 *  - GET /api/ready        (public-safe MINIMAL summaries — §42/§93),
 *  - GET /api/v1/platform/system (Platform System, detailed safe view — §43).
 *
 * Semantics (§40/§41):
 *  - "ready"    → safe to serve production traffic;
 *  - "degraded" → serving, with honest operational gaps (optional components
 *                 unconfigured/stale) — readiness must NOT fail merely
 *                 because payments are intentionally disabled, IRR is not
 *                 configured, or legal review is pending;
 *  - "blocked"  → NOT safe to serve (database unreachable, migrations
 *                 pending, mandatory production configuration invalid).
 *
 * Component status vocabulary (§171): READY · PARTIAL · BLOCKED ·
 * NOT_CONFIGURED · STALE · REQUIRES_REVIEW · DISABLED.
 *
 * Caching (§90/§91): short cache only (3s) so configuration/state changes
 * become visible predictably; never a long interval.
 *
 * Privacy (§42/§93/§172): component statuses only. NO migration names, NO
 * database paths, NO backup file paths/timestamps, NO provider model names,
 * NO AI cost figures, NO business/user counts, NO SMTP details.
 */
import { db } from "@/lib/db";
import { APP_VERSION } from "@/lib/app-version";
import { getProductionConfigReport, type ConfigStatus } from "@/lib/config/production";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { logWarn } from "@/lib/observability/logger";

export type ReadinessComponent =
  | "READY"
  | "PARTIAL"
  | "BLOCKED"
  | "NOT_CONFIGURED"
  | "STALE"
  | "REQUIRES_REVIEW"
  | "DISABLED";

export type ReadinessOverall = "ready" | "degraded" | "blocked";

export type ReadinessComponents = {
  database: ReadinessComponent;
  migrations: ReadinessComponent;
  configuration: ReadinessComponent;
  email: ReadinessComponent;
  payments: ReadinessComponent;
  aiCostRates: ReadinessComponent;
  legal: ReadinessComponent;
  backups: ReadinessComponent;
  restoreDrill: ReadinessComponent;
  /** Prompt 30 §186 — identity-security posture (safe states only). */
  mfa: ReadinessComponent;
  emailVerification: ReadinessComponent;
  /** Prompt 31 §305 — portability storage posture (safe state only). */
  portabilityStorage: ReadinessComponent;
  /** Prompt 32 §380/§446 — notification platform posture (safe state only). */
  notifications: ReadinessComponent;
};

export type ReadinessResult = {
  ready: ReadinessOverall;
  version: string;
  components: ReadinessComponents;
  /** Internal-only diagnostics (Platform System); NEVER in public payloads. */
  internal: {
    migrationsApplied: number;
    migrationsPending: number;
    blockingProblems: string[];
    lastBackup: { exists: boolean; verified: boolean; ageHours: number | null } | null;
    lastRestoreDrill: { ranAt: string | null; result: "PASS" | "FAIL" | null; ageDays: number | null } | null;
  };
};

/* ------------------------------ backup files ------------------------------ */

const READINESS_CACHE_MS = 3_000;
let cache: { at: number; result: ReadinessResult } | null = null;

function backupDir(): string {
  const configured = (process.env.BACKUP_DIR ?? "").trim();
  if (configured) return configured;
  // Project convention (docs/deployment/backup-restore-plan.md): db/backups.
  return "db/backups";
}

function resolveBackupDir(): string {
  const dir = backupDir();
  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}

export type BackupSidecar = {
  createdAt: string;
  sha256: string;
  verified: boolean;
  integrity: { integrityCheck: string; quickCheck: string; foreignKeyViolations: number };
  appVersion: string;
};

/** Read the latest backup sidecar metadata (never file paths to callers). */
function readLatestBackup(): { sidecar: BackupSidecar | null; ageHours: number | null } {
  try {
    const dir = resolveBackupDir();
    if (!existsSync(dir)) return { sidecar: null, ageHours: null };
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f.startsWith("backup-") && !f.startsWith("last-"))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const raw = JSON.parse(
          readFileSync(join(dir, f), "utf8"),
        ) as Partial<BackupSidecar>;
        if (typeof raw.createdAt !== "string" || typeof raw.sha256 !== "string") continue;
        const ageHours = (Date.now() - new Date(raw.createdAt).getTime()) / 3_600_000;
        return {
          sidecar: {
            createdAt: raw.createdAt,
            sha256: raw.sha256,
            verified: raw.verified === true,
            integrity: {
              integrityCheck: String(raw.integrity?.integrityCheck ?? "unknown"),
              quickCheck: String(raw.integrity?.quickCheck ?? "unknown"),
              foreignKeyViolations: Number(raw.integrity?.foreignKeyViolations ?? -1),
            },
            appVersion: String(raw.appVersion ?? "unknown"),
          },
          ageHours,
        };
      } catch {
        continue;
      }
    }
    return { sidecar: null, ageHours: null };
  } catch {
    return { sidecar: null, ageHours: null };
  }
}

export type RestoreDrillRecord = {
  ranAt: string;
  result: "PASS" | "FAIL";
  backup: string;
  checksumVerified: boolean;
};

/** Read the last restore-drill result (written by scripts/restore-drill.mjs). */
function readLastRestoreDrill(): RestoreDrillRecord | null {
  try {
    const dir = resolveBackupDir();
    const file = join(dir, "last-restore-drill.json");
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RestoreDrillRecord>;
    if (typeof raw.ranAt !== "string" || (raw.result !== "PASS" && raw.result !== "FAIL")) {
      return null;
    }
    return {
      ranAt: raw.ranAt,
      result: raw.result,
      backup: String(raw.backup ?? "").replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 80),
      checksumVerified: raw.checksumVerified === true,
    };
  } catch {
    return null;
  }
}

/* ------------------------------- computation ------------------------------- */

function backupMaxAgeHours(): number {
  const n = Number((process.env.BACKUP_MAX_AGE_HOURS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 26; // default: daily cadence + slack
}

function restoreDrillMaxAgeDays(): number {
  const n = Number((process.env.RESTORE_DRILL_MAX_AGE_DAYS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function computeReadiness(): Promise<ReadinessResult> {
  if (cache && Date.now() - cache.at < READINESS_CACHE_MS) return cache.result;

  const components: ReadinessComponents = {
    database: "BLOCKED",
    migrations: "BLOCKED",
    configuration: "BLOCKED",
    email: "NOT_CONFIGURED",
    payments: "BLOCKED",
    aiCostRates: "NOT_CONFIGURED",
    legal: "REQUIRES_REVIEW",
    backups: "NOT_CONFIGURED",
    restoreDrill: "NOT_CONFIGURED",
    // Prompt 30 §186 — honest identity-security states.
    mfa: "DISABLED",
    emailVerification: "DISABLED",
    // Prompt 31 §305 — honest portability storage state.
    portabilityStorage: "NOT_CONFIGURED",
    // Prompt 32 §380 — honest notification platform state.
    notifications: "NOT_CONFIGURED",
  };
  const internal: ReadinessResult["internal"] = {
    migrationsApplied: 0,
    migrationsPending: 0,
    blockingProblems: [],
    lastBackup: null,
    lastRestoreDrill: null,
  };

  // 1) Database + migrations (connection + migration table read).
  try {
    const rows = (await db.$queryRawUnsafe<Array<{ finished_at: number | null }>>(
      `SELECT finished_at FROM "_prisma_migrations"`,
    )) as Array<{ finished_at: number | null }>;
    components.database = "READY";
    internal.migrationsApplied = rows.filter((r) => r.finished_at !== null).length;
    internal.migrationsPending = rows.filter((r) => r.finished_at === null).length;
    components.migrations =
      internal.migrationsPending === 0 ? "READY" : "BLOCKED";
  } catch {
    components.database = "BLOCKED";
    components.migrations = "BLOCKED";
    logWarn(OPERATIONAL_EVENTS.databaseConnectionFailed, { operation: "readiness" });
  }

  // 2) Mandatory production configuration (§6).
  const report = getProductionConfigReport();
  internal.blockingProblems = report.blockingProblems;
  components.configuration = report.mandatorySatisfied ? "READY" : "BLOCKED";

  // 2b) Prompt 30 §186 — MFA + email-verification states (§402: explicit,
  // no hidden behavior). DISABLED/ENABLED_CONFIGURED/BLOCKED map onto the
  // unified vocabulary; the public DTO does NOT expose them (§187 — only
  // Platform System shows enabled/configured/blocked).
  components.mfa =
    report.identitySecurity.mfaState === "DISABLED"
      ? "DISABLED"
      : report.identitySecurity.mfaState === "ENABLED_CONFIGURED"
        ? "READY"
        : "BLOCKED";
  components.emailVerification =
    report.identitySecurity.emailVerificationState === "OFF"
      ? "DISABLED"
      : report.identitySecurity.emailVerificationState === "BLOCKED"
        ? "BLOCKED"
        : "READY"; // OPTIONAL/REQUIRED with SMTP → operational

  // 3) Email transport (§17/§100 — no fake intermediate states).
  components.email =
    report.email.status === "CONFIGURED"
      ? "READY"
      : report.email.status === "INVALID"
        ? "BLOCKED"
        : "NOT_CONFIGURED";

  // 4) Payments (§102/§177 — report-only; intentionally disabled is honest).
  components.payments = report.payments.productionActive
    ? "READY"
    : report.payments.paymentsEnabled.status === "DISABLED"
      ? "BLOCKED"
      : "NOT_CONFIGURED";

  // 5) AI cost rates (§103/§178 — never invented; 0 verified rates stays honest).
  try {
    const { getAiCostHealth } = await import("@/lib/ai/cost/economics");
    const health = await getAiCostHealth(30);
    components.aiCostRates = health.verifiedRates > 0 ? "READY" : "NOT_CONFIGURED";
  } catch {
    components.aiCostRates = "NOT_CONFIGURED";
  }

  // 6) Legal (§179 — REQUIRES_REVIEW until review actually completed).
  try {
    const { LEGAL_DOCUMENTS } = await import("@/content/legal/registry");
    const reviewPending = Object.values(LEGAL_DOCUMENTS).some(
      (d) => d.legalReviewRequired || d.effectiveDate === null,
    );
    const contactsReady =
      report.publicTrust.privacyEmail.status === "CONFIGURED" &&
      report.publicTrust.legalEmail.status === "CONFIGURED" &&
      report.publicTrust.securityEmail.status === "CONFIGURED";
    components.legal = reviewPending
      ? "REQUIRES_REVIEW"
      : contactsReady
        ? "READY"
        : "PARTIAL";
  } catch {
    components.legal = "REQUIRES_REVIEW";
  }

  // 7) Backups (§104/§105) + restore drill (§106).
  const backup = readLatestBackup();
  const drill = readLastRestoreDrill();
  if (backup.sidecar && backup.ageHours !== null) {
    const ageHours = backup.ageHours;
    internal.lastBackup = {
      exists: true,
      verified: backup.sidecar.verified,
      ageHours: Math.round(ageHours * 10) / 10,
    };
    const stale = ageHours > backupMaxAgeHours();
    if (stale) components.backups = "STALE";
    else components.backups = backup.sidecar.verified ? "READY" : "PARTIAL";
  } else {
    internal.lastBackup = { exists: false, verified: false, ageHours: null };
    components.backups = "NOT_CONFIGURED";
  }
  if (drill) {
    const ageDays = (Date.now() - new Date(drill.ranAt).getTime()) / 86_400_000;
    internal.lastRestoreDrill = {
      ranAt: drill.ranAt,
      result: drill.result,
      ageDays: Math.round(ageDays * 10) / 10,
    };
    if (drill.result === "FAIL") components.restoreDrill = "BLOCKED";
    else if (ageDays > restoreDrillMaxAgeDays()) components.restoreDrill = "STALE";
    else components.restoreDrill = "READY";
  } else {
    internal.lastRestoreDrill = { ranAt: null, result: null, ageDays: null };
    components.restoreDrill = "NOT_CONFIGURED";
  }

  // 7b) Prompt 31 §305 — portability storage (probe write, safe status only;
  // NO paths). Vocabulary mapping: READY→READY · INVALID root→BLOCKED ·
  // NOT_WRITABLE→NOT_CONFIGURED (configured but unusable). Degraded, never
  // a core blocker — the product serves with exports/imports unavailable.
  try {
    const { probeStorageHealth } = await import("@/lib/data-portability/config");
    const storage = probeStorageHealth();
    components.portabilityStorage =
      storage.status === "READY"
        ? "READY"
        : storage.status === "INVALID"
          ? "BLOCKED"
          : "NOT_CONFIGURED";
  } catch {
    components.portabilityStorage = "NOT_CONFIGURED";
  }

  // 7b) Prompt 32 §380/§446 — notification platform: catalog healthy +
  // storage reachable + bounded config. Safe STATUSES only — no internals,
  // no paths, no provider details (§381).
  try {
    const { notificationCatalogHealth } = await import("@/lib/notifications");
    const health = notificationCatalogHealth();
    const emailReady = components.email === "READY";
    components.notifications =
      health.healthy && emailReady
        ? "READY"
        : health.healthy
          ? "PARTIAL" // catalog healthy, email transport not configured — in-app still works
          : "BLOCKED";
  } catch {
    components.notifications = "BLOCKED";
  }

  // 8) Overall (§40/§41): blocked only for CORE failures; optional gaps are
  // degraded, not blocked.
  const coreFailed =
    components.database === "BLOCKED" ||
    components.migrations === "BLOCKED" ||
    components.configuration === "BLOCKED";
  const degraded = (
    ["email", "aiCostRates", "backups", "restoreDrill", "legal", "portabilityStorage", "notifications"] as const
  ).some((k) => components[k] !== "READY");

  const result: ReadinessResult = {
    ready: coreFailed ? "blocked" : degraded ? "degraded" : "ready",
    version: APP_VERSION,
    components,
    internal,
  };
  cache = { at: Date.now(), result };
  return result;
}

/** Public-safe readiness payload (§42/§93/§172) — statuses + version ONLY. */
export type PublicReadinessDTO = {
  status: ReadinessOverall;
  version: string;
  timestamp: string;
  components: Record<string, ReadinessComponent>;
};

export function publicReadinessDTO(r: ReadinessResult): PublicReadinessDTO {
  const { internal: _internal, ...rest } = r;
  void _internal;
  return {
    status: rest.ready,
    version: rest.version,
    timestamp: new Date().toISOString(),
    components: {
      database: rest.components.database,
      migrations: rest.components.migrations,
      configuration: rest.components.configuration,
      email: rest.components.email,
      payments: rest.components.payments,
      aiCostRates: rest.components.aiCostRates,
      legal: rest.components.legal,
      backups: rest.components.backups,
      restoreDrill: rest.components.restoreDrill,
      // §305/§358 — portability storage status WITHOUT paths/secrets.
      portabilityStorage: rest.components.portabilityStorage,
      // Prompt 32 §380/§381 — notification platform status WITHOUT internals.
      notifications: rest.components.notifications,
      // §187 — MFA/encryption state is deliberately NOT public; only the
      // Platform System view (internal) shows enabled/configured/blocked.
    },
  };
}

/** Re-export the unified vocabulary for consumers (§4). */
export type UnifiedStatus = ConfigStatus | ReadinessComponent;

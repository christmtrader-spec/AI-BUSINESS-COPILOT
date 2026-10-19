/**
 * Next.js instrumentation — Prompt 29 §6/§70/§71.
 *
 * Runs once per server process start (nodejs runtime).
 *
 * Startup law (§6): in PRODUCTION, invalid MANDATORY configuration
 * (DATABASE_URL / NEXTAUTH_SECRET / NEXTAUTH_URL) makes the process exit
 * non-zero IMMEDIATELY — the application must never sit in a misleading
 * half-started state (§71). Optional components (email, legal contacts,
 * backups) do NOT refuse startup; they surface honest NOT_CONFIGURED state
 * through /api/ready and Platform System.
 *
 * Shutdown law (§70): SIGTERM/SIGINT trigger a bounded graceful shutdown —
 * flush pending logs, disconnect Prisma cleanly, exit 0. A hard cap
 * (GRACEFUL_SHUTDOWN_TIMEOUT_MS, default 8s) prevents an indefinite hang.
 *
 * NOTE (§74/§73): this file also refuses nothing about concurrency —
 * single-instance operation is a documented operator responsibility
 * (docs/deployment/production-operations.md).
 */
export async function register(): Promise<void> {
  console.log(
    JSON.stringify({
      event: "startup.instrumentation_register",
      level: "info",
      service: "ai-business-copilot",
      runtime: process.env.NEXT_RUNTIME ?? "unknown",
    }),
  );
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ---- startup validation (§6) -------------------------------------------
  try {
    const { startupBlockingProblems } = await import("@/lib/config/production");
    const blocking = startupBlockingProblems();
    if (blocking.length > 0) {
      // Safe output: problem CODES only — never values (§4/§21/§27).
      console.error(
        JSON.stringify({
          event: "startup.configuration_invalid",
          level: "error",
          service: "ai-business-copilot",
          problems: blocking,
        }),
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "startup.validation_error",
        level: "error",
        service: "ai-business-copilot",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
    process.exit(1);
  }

  // ---- billing catalog self-heal (permanent fix) ---------------------------
  // The environment has repeatedly wiped the billing catalog out of the DB
  // (User rows survive; Plan/EntitlementDefinition/PlanEntitlement/PriceBook
  // are gone), which made every business creation fail with the controlled
  // BILLING_UNAVAILABLE error. Healing at boot makes the platform
  // self-repairing: by the time the first request is served, the canonical
  // catalog is guaranteed. Best-effort and non-fatal — a failure here is
  // logged and the honest fail-closed guards remain the last resort (§68).
  try {
    const { ensureBillingCatalog } = await import("@/lib/billing/self-heal");
    const health = await ensureBillingCatalog("startup");
    if (health.healthy) {
      console.log(
        JSON.stringify({
          event: "startup.billing_catalog_ready",
          level: "info",
          service: "ai-business-copilot",
          plans: health.plansMissing.length === 0 ? "complete" : "healed",
        }),
      );
    } else {
      console.error(
        JSON.stringify({
          event: "startup.billing_catalog_unhealthy",
          level: "error",
          service: "ai-business-copilot",
        }),
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "startup.billing_catalog_heal_failed",
        level: "warn",
        service: "ai-business-copilot",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }

  // ---- graceful shutdown (§70) --------------------------------------------
  const globalForShutdown = globalThis as unknown as {
    __p29ShutdownInstalled?: boolean;
  };
  if (globalForShutdown.__p29ShutdownInstalled) return;
  globalForShutdown.__p29ShutdownInstalled = true;

  let shuttingDown = false;
  const timeoutMs = (() => {
    const n = Number((process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS ?? "").trim());
    return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? n : 8_000;
  })();

  const shutdown = (signal: "SIGTERM" | "SIGINT", code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // First: emit a safe structured line so process managers can correlate.
    process.stdout.write(
      `${JSON.stringify({
        event: "shutdown.begin",
        level: "info",
        service: "ai-business-copilot",
        signal,
      })}\n`,
    );
    // Bounded: never hang the container (§70).
    const hardExit = setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          event: "shutdown.timeout",
          level: "warn",
          service: "ai-business-copilot",
          timeoutMs,
        })}\n`,
      );
      process.exit(code);
    }, timeoutMs);
    hardExit.unref();

    void (async () => {
      try {
        const { db } = await import("@/lib/db");
        await db.$disconnect();
      } catch {
        // Prisma may already be gone — shutdown proceeds regardless.
      }
      process.stdout.write(
        `${JSON.stringify({
          event: "shutdown.complete",
          level: "info",
          service: "ai-business-copilot",
          signal,
        })}\n`,
      );
      process.exit(code);
    })();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
}

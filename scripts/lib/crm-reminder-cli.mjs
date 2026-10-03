/**
 * scripts/lib/crm-reminder-cli.mjs — Prompt 37-F §5–§9.
 *
 * PURE, dependency-free CLI argument parser for the operator-scheduled CRM
 * reminder processor. Extracted from the entry script so the flag semantics
 * are unit-testable (scripts/prompt37-unit.ts areas 1–3/19/20) and the
 * entry script only wires parse → validate → run.
 *
 * FLAG MATRIX (deterministic, documented — §6):
 *   (no flags)            → DRY_RUN (the safe default, §65)
 *   --dry-run             → DRY_RUN (explicit; idempotent when repeated)
 *   --apply               → APPLY    (idempotent when repeated)
 *   --apply --dry-run     → INVALID  (conflict — exit 1 BEFORE any run)
 *   --foobar              → INVALID  (unknown flag — exit 1)
 *   --business-id=<id>    → scoped run; MUST match ^[a-zA-Z0-9_-]{6,64}$
 *                           (the same safe ID validation Prompt 37 uses
 *                           inside the processor, §7/§197)
 *   --max=<n>             → STRICT: decimal integer within 10–500 (§8/§43).
 *                           Non-numeric, fractional, out-of-bounds ⇒ INVALID
 *                           — the CLI never silently clamps a dangerous
 *                           workload. Last occurrence wins (deterministic).
 *
 * Safety laws (§9): no eval, no Function(), no dynamic execution, no
 * environment-controlled command execution — pure string/number checks.
 */

export const CLI_BUSINESS_ID_PATTERN = /^[a-zA-Z0-9_-]{6,64}$/;
export const CLI_MAX_MIN = 10;
export const CLI_MAX_MAX = 500;

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ ok: true, options: { dryRun: boolean, maxTasks?: number, businessId?: string } }
 *         | { ok: false, code: string, message: string }}
 */
export function parseReminderCliArgs(argv) {
  let apply = false;
  let dryRun = false;
  let maxRaw = null; // last occurrence wins (deterministic, documented)
  let businessRaw = null;
  const unknown = [];

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true; // duplicate booleans accepted idempotently (§6)
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (typeof arg === "string" && arg.startsWith("--max=")) {
      maxRaw = arg.slice("--max=".length);
    } else if (typeof arg === "string" && arg.startsWith("--business-id=")) {
      businessRaw = arg.slice("--business-id=".length);
    } else {
      unknown.push(String(arg));
    }
  }

  // §5 — the conflict is detected HERE, before any processor invocation,
  // before any database access, before any write-capable operation.
  if (apply && dryRun) {
    return {
      ok: false,
      code: "CONFLICTING_FLAGS",
      message: "conflicting flags: --apply and --dry-run cannot be combined",
    };
  }
  if (unknown.length > 0) {
    // Safe error — the offending flag NAME is operator input, not data.
    return {
      ok: false,
      code: "UNKNOWN_FLAG",
      message: `unknown flag: ${unknown[0].slice(0, 64)}`,
    };
  }

  let maxTasks;
  if (maxRaw !== null) {
    // §8 — strict: /^\d+$/ rejects "", "abc", "10.5", "1e3", "0x10", "-5",
    // "+5". No Number coercion games, no eval.
    if (!/^\d+$/.test(maxRaw)) {
      return {
        ok: false,
        code: "INVALID_MAX",
        message: "--max must be a decimal integer",
      };
    }
    const n = Number.parseInt(maxRaw, 10);
    if (!Number.isFinite(n) || n < CLI_MAX_MIN || n > CLI_MAX_MAX) {
      return {
        ok: false,
        code: "MAX_OUT_OF_RANGE",
        message: `--max must be between ${CLI_MAX_MIN} and ${CLI_MAX_MAX}`,
      };
    }
    maxTasks = n;
  }

  let businessId;
  if (businessRaw !== null) {
    // §7 — validate immediately with the SAME safe ID law as the processor.
    // An empty or malformed id is a caller error, never a partial run.
    if (businessRaw.length === 0 || !CLI_BUSINESS_ID_PATTERN.test(businessRaw)) {
      return {
        ok: false,
        code: "INVALID_BUSINESS_ID",
        message: "--business-id must match ^[a-zA-Z0-9_-]{6,64}$",
      };
    }
    businessId = businessRaw;
  }

  const options = { dryRun: apply ? false : true };
  if (maxTasks !== undefined) options.maxTasks = maxTasks;
  if (businessId !== undefined) options.businessId = businessId;
  return { ok: true, options };
}

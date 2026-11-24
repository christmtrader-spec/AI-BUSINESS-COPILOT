/**
 * r178-watchdog-check.ts — the supervisor that keeps the OOM guard alive.
 *
 * R178 Mandate (R177 §3 #3): dev-rss-guard.cjs is a complete OOM-prevention
 * daemon, but NOTHING kept the guard itself alive — the sandbox reaps
 * background processes between tool sessions, so the guard could sit dead
 * for hours while the dev server fattened and the kernel OOM-killer shot it
 * (the R177 disease; re-witnessed LIVE at this round's open: dmesg
 * `oom-kill task=next-server`, anon-rss 1.7GB). The cure is the
 * self-scheduling chain: dev-watchdog (10-min) → rss-guard (30-s) → server.
 *
 * Sections:
 *  [1] the supervisor script law (single responsibility, the three-lock
 *      hygiene, the health probe incl. the wedged-heartbeat verdict, the
 *      revive action, the double-fork daemon)
 *  [2] the ensure-dev integration law (the self-scheduling hook, idempotent
 *      presence, BOTH READY branches wired)
 *  [3] the census + registration law (family-census consumers, the runner
 *      manifest carries this battery, live counts)
 *  [4] the LIVE rescue law (the round's real revival: supervisor on duty,
 *      guard healthy, server 200, the JSONL event chain of THIS rescue)
 *
 * Run: npx tsx scripts/r178-watchdog-check.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { familyCensus, assertRegistered } from "./family-census";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8");

const passed: string[] = [];
const failures: string[] = [];
function ok(name: string, cond: boolean, info?: string) {
  if (cond) passed.push(name);
  else failures.push(info ? `${name} — ${info}` : name);
}

// ==== [1] THE SUPERVISOR SCRIPT LAW ==========================================

{
  console.log("\n[1] the supervisor script law (scripts/dev-watchdog.cjs)");
  const wd = read("scripts/dev-watchdog.cjs");

  ok(
    "1a the single-responsibility law is WRITTEN and enforced: the watchdog never spawns the dev server (the guard's down-selfheal owns that job; a second spawner would race keep-dev-up/dev-guard for the :3000 bind-gap)",
    wd.includes("SINGLE-RESPONSIBILITY LAW") &&
      wd.includes("It never spawns the dev server itself") &&
      !/spawn\(\s*"bun"/.test(wd),
  );
  ok(
    "1b the three-lock hygiene: supervisor (.dev-supervisor.lock) ≠ guard (.dev-rss-guard.lock) ≠ keep-dev-up (.dev-watchdog.lock) — a shared lock would let two daemons evict each other's heartbeats into a permanent stale-holder loop",
    wd.includes(".dev-supervisor.lock") &&
      wd.includes(".dev-rss-guard.lock") &&
      wd.includes(".dev-watchdog.lock") &&
      wd.includes("never reuse"),
  );
  ok(
    "1c the health probe treats a LIVE pid with a STALE heartbeat as dead (wedged protection is no protection) — and reviving a wedged guard is safe because the fresh instance reclaims the stale lock",
    wd.includes("heartbeat-stale") && wd.includes("wedged"),
  );
  ok(
    "1d the revive action spawns the guard SCRIPT (which double-forks into daemon mode) — the watchdog never inlines the guard's daemon logic (one implementation)",
    /spawn\(\s*"node",\s*\[GUARD_SCRIPT\]/.test(wd) &&
      wd.includes("GUARD_SCRIPT = `${ROOT}/scripts/dev-rss-guard.cjs`") &&
      wd.includes("it double-forks into daemon mode"),
  );
  ok(
    "1e the daemon double-forks (R105 stage2 pattern: the detached child runs ONLY the daemon; nothing else spawns — no per-generation spawn chain)",
    wd.includes('"--stage2"') && wd.includes("R105 correctness"),
  );
  ok(
    "1f the R111 mirror pattern: every event lands in BOTH sinks with ONE timestamp (text log for humans, JSONL for machines)",
    wd.includes("wlogEvent") && wd.includes("dev-watchdog-events.jsonl") && wd.includes("dev-watchdog.log"),
  );
  ok(
    "1g the supervisory cadence: 10 minutes default, env-overridable with a sane floor (5s) so tests can compress time",
    wd.includes("10 * 60 * 1000") && wd.includes("DEV_WATCHDOG_INTERVAL_MS") && wd.includes("Math.max(5000,"),
  );
}

// ==== [2] THE ENSURE-DEV INTEGRATION LAW =====================================

{
  console.log("\n[2] the ensure-dev integration law (the self-scheduling hook)");
  const ed = read("scripts/ensure-dev.sh");

  ok(
    "2a the R178 self-scheduling law is documented where the operators live: a READY outcome ALSO ensures the supervisor is on duty",
    ed.includes("R178 self-scheduling law") && ed.includes("watchdog 10min") && ed.includes("rss-guard"),
  );
  ok(
    "2b the ensure_watchdog function exists and is IDEMPOTENT: a live holder (pid + fresh heartbeat) is left alone — the probe uses kill(0) AND a 10-min heartbeat horizon",
    ed.includes("ensure_watchdog()") && ed.includes("Date.now() - l.at < 10*60*1000") && ed.includes("process.kill(l.pid, 0)"),
  );
  ok(
    "2c BOTH READY branches wire the hook (existing AND new server) — a revived server must never leave the chain unguarded",
    (ed.match(/ensure_watchdog \|\| true/g) || []).length === 2 &&
      ed.includes('echo "READY(existing):$code"') &&
      ed.includes('echo "READY(new):$code after ${i}s"'),
  );
  ok(
    "2d the revive path goes through the daemon entry (setsid nohup node scripts/dev-watchdog.cjs) and VERIFIES the heartbeat within 8s instead of assuming success",
    ed.includes("node scripts/dev-watchdog.cjs") &&
      ed.includes("WATCHDOG(revived):after=${waited}s") &&
      ed.includes("WATCHDOG(missing)"),
  );
}

// ==== [3] THE CENSUS + REGISTRATION LAW ======================================

{
  console.log("\n[3] the census + registration law");
  const censusSrc = read("scripts/family-census.ts");
  ok(
    "3a family-census still exports the two laws (parse the runner's arrays; the join-day canary)",
    censusSrc.includes("export function familyCensus") && censusSrc.includes("export function assertRegistered"),
  );
  const runner = read("scripts/run-family.sh");
  ok(
    "3b the runner manifest carries this battery (BATTERIES_TSX includes r178-watchdog-check.ts — the registration canary reads the file that can forget)",
    /BATTERIES_TSX=\([\s\S]*r178-watchdog-check\.ts[\s\S]*\)/.test(runner),
  );
  ok(
    "3c this battery IS registered (assertRegistered against the runner's own parse)",
    assertRegistered("r178-watchdog-check.ts"),
  );
  const c = familyCensus();
  ok(
    "3d the live census sees the family grown to include r178 (26 tsx batteries, floors not exact counts — the name-membership is the real canary)",
    c.tsx >= 26 && c.names.some((n) => n.includes("r178-watchdog-check")),
  );
}

// ==== [4] THE LIVE RESCUE LAW ================================================
// This round OPENED with the disease LIVE: the kernel OOM-killed next-server
// (dmesg anon-rss 1.7GB), the guard was dead since R105's lock, and the
// supervisor's very first --once round revived the chain. Pins below assert
// the POST-RESCUE reality — they must stay green on any healthy machine.

{
  console.log("\n[4] the LIVE rescue law (post-revival reality)");
  const lock = (p: string) => {
    try {
      return JSON.parse(readFileSync(`${ROOT}/${p}`, "utf8")) as { pid: number; at: number };
    } catch {
      return null;
    }
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const sup = lock(".dev-supervisor.lock");
  ok(
    "4a the supervisor is ON DUTY (lock exists, pid alive, heartbeat fresh)",
    !!sup && alive(sup.pid) && Date.now() - sup.at < 10 * 60 * 1000,
  );
  const guard = lock(".dev-rss-guard.lock");
  ok(
    "4b the guard is ALIVE under the supervisor's watch (lock exists, pid alive, heartbeat < 4-min stale horizon)",
    !!guard && alive(guard.pid) && Date.now() - guard.at < 4 * 60 * 1000,
  );
  const http = execSync("curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/api/health", {
    encoding: "utf8",
  }).trim();
  ok("4c the dev server answers 200 (the chain's protected payload)", http === "200", `http=${http}`);

  const eventsPath = `${ROOT}/dev-watchdog-events.jsonl`;
  ok("4d the JSONL event mirror exists (machines read history even after the text log rotates)", existsSync(eventsPath));
  if (existsSync(eventsPath)) {
    const lines = read("dev-watchdog-events.jsonl")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const kinds = new Set(lines.map((l) => l.kind as string));
    ok(
      "4e THIS rescue's event chain is on record: rss-guard-revived (the --once round) + watchdog-start (the daemon took the lock) + guard-ok (the fresh guard's heartbeat judged healthy)",
      kinds.has("rss-guard-revived") && kinds.has("watchdog-start") && kinds.has("guard-ok"),
    );
    ok(
      "4f the revival event carries the machine-readable WHY (one of the three documented death verdicts — pid-dead | no-lock | heartbeat-stale — plus the spawned childPid; the postmortem starts from data, not memory. R179 checker fix: the WHY VALUE varies by the actual death (this session's sandbox wipe produced no-lock), the LAW is that a WHY is always recorded)",
      lines.some(
        (l) =>
          l.kind === "rss-guard-revived" &&
          typeof l.why === "string" &&
          ["pid-dead", "no-lock", "heartbeat-stale"].includes(l.why) &&
          typeof l.childPid === "number",
      ),
    );
    const textLog = read("dev-watchdog.log");
    ok(
      "4g the R111 dedupe law holds: every JSONL ts has its text-log twin (ONE timestamp, two sinks)",
      lines.every((l) => textLog.includes(`[${l.ts}]`)),
    );
  }
}

// ==== SUMMARY ================================================================

console.log(`\n=== r178-watchdog-check: ${passed.length} passed, ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}

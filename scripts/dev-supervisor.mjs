#!/usr/bin/env node
/**
 * dev-supervisor.mjs — the R96 watchdog (the R94/R95 candidate ①: the
 * evidence was overwhelming — 5+ mid-session dev-server recycles per round,
 * two harness runs killed mid-flight, one leaked its fixtures).
 *
 * WHAT IT DOES (and does NOT do):
 *   - every PROBE_INTERVAL_MS: curl-class probe of /api/health (HTTP 200);
 *   - 2 consecutive failures → the keep-dev-up.cjs spawn law, verbatim:
 *     distinguish "booting" (port occupied, not answering) from "down"
 *     (port free twice), pkill the half-dead chain, spawn `bun run dev`
 *     detached with stdio → dev.log, never a second Turbopack on :3000;
 *   - every recycle is LOGGED (supervisor.log, ISO timestamps, running
 *     recycle counter) so a later session can read the churn history;
 *   - touches NO app source, NO database, NO PlatformSetupKey — it probes
 *     a URL and (rarely) spawns the dev server, nothing else.
 *
 * SINGLETON LAW: a heartbeat lockfile (.dev-supervisor.lock, refreshed
 * every tick) makes the LOOP exclusive — a stale heartbeat (SUPERVISOR_STALE_MS)
 * is reclaimed. The SPAWN law additionally re-uses keep-dev-up's boot-gap
 * recheck (pgrep for `next dev`) so the supervisor and ensure-dev.sh (the
 * 5-minute liveness cron) can never race a duplicate Turbopack onto :3000.
 *
 * BACKOFF LAW: at most one spawn per MIN_SPAWN_INTERVAL_MS, and after
 * MAX_CONSECUTIVE_SPAWN_FAILURES failed spawn cycles the supervisor backs
 * off to BACKOFF_MS (never gives up — ensure-dev.sh stays the backstop).
 *
 * MODES:
 *   (default)      run the watchdog loop in this process
 *   --ensure       silent: start the loop detached if no LIVE supervisor
 *                  (heartbeat fresh); exit 0 always — safe to call from
 *                  ensure-dev.sh on every liveness tick
 *   --status       one line: running (pid, recycles, uptime) | stopped
 *   --stop         SIGTERM the running supervisor, remove the lockfile
 *
 * Logs: supervisor.log (this watchdog's own history) — dev.log stays the
 * server's own log, as the liveness cron expects it.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEALTH_URL = "http://localhost:3000/api/health";
const DEV_LOG = path.join(ROOT, "dev.log");
const SUPERVISOR_LOG = path.join(ROOT, "supervisor.log");
const LOCK = path.join(ROOT, ".dev-supervisor.lock");

const PROBE_INTERVAL_MS = 30_000; // the R94 candidate's spec: health-check every 30s
const FAILURES_TO_ACT = 2; // 2 consecutive failed probes → recycle (a mid-boot server gets its grace)
const SUPERVISOR_STALE_MS = 90_000; // heartbeat older than this → the holder is dead
const MIN_SPAWN_INTERVAL_MS = 60_000; // never spawn twice within a minute
const MAX_CONSECUTIVE_SPAWN_FAILURES = 5;
const BACKOFF_MS = 5 * 60_000; // after repeated failed spawn cycles, back off (never quit)

const MODE = process.argv.includes("--ensure")
  ? "ensure"
  : process.argv.includes("--status")
    ? "status"
    : process.argv.includes("--stop")
      ? "stop"
      : "run";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function log(line) {
  try {
    fs.appendFileSync(SUPERVISOR_LOG, `${nowIso()} ${line}\n`);
  } catch {
    /* logging must never kill the watchdog */
  }
}

function httpUp() {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", HEALTH_URL],
      { encoding: "utf8" },
    );
    return out.trim() === "200";
  } catch {
    return false;
  }
}

/** True when something holds :3000 even if it doesn't answer HTTP yet
 *  (mid-boot) — never spawn a second instance onto an occupied port. */
function portOccupied() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(3000, "127.0.0.1");
  });
}

function readLock() {
  try {
    const { pid, at, recycles } = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    return { pid, at, recycles: recycles ?? 0 };
  } catch {
    return null;
  }
}

function writeLock(recycles) {
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), recycles }));
  } catch {
    /* best-effort */
  }
}

function heartbeat(recycles) {
  writeLock(recycles);
}

function lockHolderAlive(lock) {
  if (!lock?.pid || !lock?.at) return false;
  if (Date.now() - lock.at > SUPERVISOR_STALE_MS) return false; // stale heartbeat
  try {
    process.kill(lock.pid, 0); // raises if dead
    return true;
  } catch {
    return false;
  }
}

/** The keep-dev-up.cjs spawn law: clean the half-dead chain, verify the
 *  port is genuinely free (twice), re-check no `next dev` appeared in the
 *  boot gap, then spawn `bun run dev` detached into dev.log. Returns
 *  { verdict: "spawned"|"occupied"|"appeared", pid?: number }. */
async function recycleDevServer() {
  try {
    execFileSync("pkill", ["-f", "next dev -p 3000"]);
  } catch {
    /* exit 1 = nothing matched — fine */
  }
  try {
    execFileSync("pkill", ["-f", "next-server"]);
  } catch {
    /* same */
  }
  await sleep(2000);

  for (let i = 0; i < 3; i += 1) {
    if (await portOccupied()) {
      await sleep(2000); // something still owns :3000 — booting, never fight it
    } else {
      break;
    }
    if (i === 2) return { verdict: "occupied" };
  }
  await sleep(1000);
  if (await portOccupied()) return { verdict: "occupied" };

  // r21 boot-gap recheck: another agent's `next dev` may have started
  // while we probed (process alive, port not yet bound).
  try {
    const alive = execFileSync(
      "pgrep",
      ["-f", "node_modules/[.]bin/next dev|next-server "],
      { encoding: "utf8" },
    );
    if (alive.trim()) return { verdict: "appeared" };
  } catch {
    /* pgrep exit 1 → nothing alive → proceed */
  }

  const out = fs.openSync(DEV_LOG, "a");
  const child = spawn("bun", ["run", "dev"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return { verdict: "spawned", pid: child.pid };
}

async function runLoop() {
  let recycles = 0;
  let consecutiveFailures = 0;
  let lastSpawnAt = 0;
  let consecutiveSpawnFailures = 0;
  let backoffUntil = 0;
  let startedAt = Date.now();

  log(`WATCHDOG started pid=${process.pid}`);
  heartbeat(recycles);
  const heart = setInterval(() => heartbeat(recycles), PROBE_INTERVAL_MS / 2);

  const shutdown = () => {
    clearInterval(heart);
    log("WATCHDOG stopped (signal)");
    try {
      const lock = readLock();
      if (lock?.pid === process.pid) fs.rmSync(LOCK, { force: true });
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  for (;;) {
    await sleep(PROBE_INTERVAL_MS);
    heartbeat(recycles);

    if (httpUp()) {
      if (consecutiveFailures > 0) log(`healthy again (failures=${consecutiveFailures})`);
      consecutiveFailures = 0;
      continue;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures < FAILURES_TO_ACT) continue; // grace — a recompile/boot gets its window
    if (Date.now() < backoffUntil) continue; // backoff after repeated failed cycles

    if (await portOccupied()) {
      // mid-boot — someone's instance is coming up; wait, don't fight
      log("down but port occupied (booting?) — waiting");
      consecutiveFailures = 0;
      continue;
    }
    if (Date.now() - lastSpawnAt < MIN_SPAWN_INTERVAL_MS) continue;

    log(`RECYCLE #${recycles + 1} (health down ${consecutiveFailures}× consecutive) — spawning dev server`);
    const { verdict, pid } = await recycleDevServer();
    lastSpawnAt = Date.now();
    if (verdict === "spawned") {
      recycles += 1;
      consecutiveSpawnFailures = 0;
      consecutiveFailures = 0;
      heartbeat(recycles);
      log(`spawned dev server pid=${pid} (recycles=${recycles})`);
    } else {
      consecutiveSpawnFailures += 1;
      log(`spawn withheld: ${verdict} (consecutiveWithheld=${consecutiveSpawnFailures})`);
      if (consecutiveSpawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
        backoffUntil = Date.now() + BACKOFF_MS;
        consecutiveSpawnFailures = 0;
        log(`backing off ${BACKOFF_MS / 1000}s after repeated withheld spawns (ensure-dev.sh remains the backstop)`);
      }
    }
  }
}

function startDetached() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

if (MODE === "ensure") {
  const lock = readLock();
  if (lockHolderAlive(lock)) {
    process.exit(0); // a live supervisor exists — silent no-op
  }
  startDetached();
  process.exit(0);
}

if (MODE === "status") {
  const lock = readLock();
  if (lockHolderAlive(lock)) {
    console.log(
      `supervisor: RUNNING pid=${lock.pid} recycles=${lock.recycles} uptime=${Math.round((Date.now() - lock.at) / 1000)}s(heartbeat)`,
    );
  } else {
    console.log("supervisor: STOPPED");
  }
  process.exit(0);
}

if (MODE === "stop") {
  const lock = readLock();
  if (lockHolderAlive(lock)) {
    try {
      process.kill(lock.pid, "SIGTERM");
      console.log(`supervisor: sent SIGTERM to ${lock.pid}`);
    } catch (e) {
      console.log(`supervisor: kill failed: ${e.message}`);
    }
  } else {
    console.log("supervisor: not running");
  }
  try {
    fs.rmSync(LOCK, { force: true });
  } catch {
    /* best-effort */
  }
  process.exit(0);
}

await runLoop();

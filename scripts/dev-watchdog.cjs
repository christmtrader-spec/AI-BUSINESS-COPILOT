// dev-watchdog.cjs — the SUPERVISOR that keeps the OOM guard alive (R178).
//
// WHY (R177 §3 #3): dev-rss-guard.cjs is a complete OOM-prevention daemon
// (sustained-high-RSS recycle, down-selfheal, JSONL events) — but NOTHING
// kept the guard itself alive. The sandbox reaps background processes when
// tool sessions end, so the guard could be dead for hours while the dev
// server fattened to ~2.4GB and the kernel OOM-killer shot it (the R177
// disease: dmesg `oom-kill task=next-server` on the 4GB box). The cure is a
// self-scheduling chain: THIS watchdog (10-min heartbeat) → rss-guard
// daemon (30-s heartbeat) → dev server (down-selfheal inside the guard).
//
// SINGLE-RESPONSIBILITY LAW: the watchdog does ONE thing — keep the
// rss-guard daemon alive. It never spawns the dev server itself: the
// guard's down-selfheal already owns that job at a 2-sample (~60s) cadence,
// and a second spawner would race keep-dev-up/dev-guard for the :3000
// bind-gap (the r19/r21 duplicate-Turbopack disease). If the guard dies AND
// the server dies, reviving the guard is still the right move — the fresh
// guard self-heals the server within its own two samples.
//
// LOCK HYGIENE: three daemons, three distinct locks —
//   dev-rss-guard.cjs   → .dev-rss-guard.lock   (its own heartbeat)
//   keep-dev-up.cjs     → .dev-watchdog.lock    (spawn exclusivity)
//   dev-watchdog.cjs    → .dev-supervisor.lock  (THIS file — never reuse
//     the keep-dev-up name; a shared lock would let the two daemons evict
//     each other's heartbeats into a permanent "stale holder" loop).
//
// Modes:
//   node scripts/dev-watchdog.cjs            → daemon (double-detached)
//   node scripts/dev-watchdog.cjs --once     → ONE supervisory round, with
//                                              revive actions + verdict
//   node scripts/dev-watchdog.cjs --status   → guard/server/supervisor state
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");

const ROOT = "/home/z/my-project";
const LOCK = `${ROOT}/.dev-supervisor.lock`;
const LOG = `${ROOT}/dev-watchdog.log`;
const EVENTS = `${ROOT}/dev-watchdog-events.jsonl`;
const GUARD_LOCK = `${ROOT}/.dev-rss-guard.lock`;
const GUARD_SCRIPT = `${ROOT}/scripts/dev-rss-guard.cjs`;
// Guard heartbeat cadence: the guard heartbeats every ~30s (its INTERVAL_MS);
// a heartbeat older than 4 min means the guard process is wedged or dead —
// 8× the normal cadence, generous enough that one missed beat never flips
// the verdict, tight enough to catch a SIGKILLed guard well inside the
// 10-minute supervisory loop.
const GUARD_STALE_MS = 4 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000; // supervisor's own heartbeat horizon
const INTERVAL_MS = Math.max(5000, Number(process.env.DEV_WATCHDOG_INTERVAL_MS) || 10 * 60 * 1000);

const ts = () => new Date().toISOString();
function wlog(msg) {
  try {
    fs.appendFileSync(LOG, `[${ts()}] ${msg}\n`);
  } catch {
    /* logging must never crash the watchdog */
  }
}
/** Text log + structured JSONL mirror — the R111 pattern, same dedupe law. */
function wlogEvent(msg, ev) {
  const now = ts();
  try {
    fs.appendFileSync(LOG, `[${now}] ${msg}\n`);
  } catch {
    /* logging must never crash the watchdog */
  }
  if (ev && ev.kind) {
    try {
      fs.appendFileSync(EVENTS, JSON.stringify({ ts: now, kind: ev.kind, msg, ...ev.fields }) + "\n");
    } catch {
      /* mirroring must never crash the watchdog */
    }
  }
}

/** Read a lockfile → {pid, at} or null (unreadable = null, never throws). */
function readLock(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof raw.pid === "number" && typeof raw.at === "number") return raw;
    return null;
  } catch {
    return null;
  }
}

/** True when the process behind `pid` still exists. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one health probe: rss-guard alive means pid exists AND its heartbeat
 * is fresh. A live pid with a stale heartbeat is treated as dead — the guard
 * could be wedged (stopped while holding the lock), and wedged protection is
 * no protection. Reviving a wedged guard is safe: the fresh instance reclaims
 * the stale lock through tryAcquireLock's own kill(pid,0)-failed path.
 */
function guardHealthy(now = Date.now()) {
  const lock = readLock(GUARD_LOCK);
  if (!lock) return { healthy: false, why: "no-lock" };
  if (!pidAlive(lock.pid)) return { healthy: false, why: "pid-dead", pid: lock.pid };
  if (now - lock.at > GUARD_STALE_MS)
    return { healthy: false, why: "heartbeat-stale", pid: lock.pid, ageSec: Math.round((now - lock.at) / 1000) };
  return { healthy: true, pid: lock.pid, ageSec: Math.round((now - lock.at) / 1000) };
}

/** Spawn the guard detached; it double-forks itself (R105 stage2 pattern). */
function reviveGuard(why) {
  const child = spawn("node", [GUARD_SCRIPT], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  wlogEvent(`revive(${why}): spawned dev-rss-guard pid=${child.pid} — it double-forks into daemon mode`, {
    kind: "rss-guard-revived",
    fields: { why, childPid: child.pid },
  });
  return child.pid;
}

/** One supervisory round: probe → revive when dead → return the verdict. */
function superviseRound() {
  const h = guardHealthy();
  if (h.healthy) {
    wlogEvent(`guard healthy: pid=${h.pid} heartbeat ${h.ageSec}s old — nothing to do`, {
      kind: "guard-ok",
      fields: { pid: h.pid, ageSec: h.ageSec },
    });
    return { action: "ok", ...h };
  }
  const pid = reviveGuard(h.why);
  return { action: "revived", why: h.why, pid };
}

function heartbeat() {
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    /* best-effort */
  }
}

function tryAcquireLock() {
  const raw = readLock(LOCK);
  if (raw && pidAlive(raw.pid)) {
    // live holder — but if the heartbeat went stale, the holder is wedged;
    // same law as the guard's own lock: protection must be alive.
    if (Date.now() - raw.at < LOCK_STALE_MS) return false;
    try {
      process.kill(raw.pid, 0);
      return false;
    } catch {
      /* wedged — reclaim */
    }
  }
  try {
    heartbeat();
    return true;
  } catch {
    return false;
  }
}

async function daemon() {
  if (!tryAcquireLock()) {
    console.log("another dev-watchdog holds the lock — exiting");
    process.exit(0);
  }
  wlogEvent(`watchdog started pid=${process.pid} (interval=${Math.round(INTERVAL_MS / 1000)}s, guard-stale=${GUARD_STALE_MS / 1000}s)`, {
    kind: "watchdog-start",
    fields: { pid: process.pid, intervalMs: INTERVAL_MS, guardStaleMs: GUARD_STALE_MS },
  });
  for (;;) {
    heartbeat();
    superviseRound();
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

function devServerLine() {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:3000/api/health"],
      { encoding: "utf8" },
    );
    return out.trim() === "200" ? "up(200)" : `http=${out.trim()}`;
  } catch {
    return "down";
  }
}

async function main() {
  if (process.argv.includes("--once")) {
    const h = guardHealthy();
    const verdict = superviseRound();
    console.log(
      `DEV-WATCHDOG(once): guard=${h.healthy ? `healthy pid=${h.pid}` : `dead (${h.why})`} → action=${verdict.action} server=${devServerLine()}`,
    );
    process.exit(0);
  }
  if (process.argv.includes("--status")) {
    const h = guardHealthy();
    const sup = readLock(LOCK);
    let supLine = "none";
    if (sup && pidAlive(sup.pid)) supLine = `pid=${sup.pid} age=${Math.round((Date.now() - sup.at) / 1000)}s`;
    else if (sup) supLine = `stale pid=${sup.pid}`;
    console.log(
      `DEV-WATCHDOG status: supervisor=${supLine} guard=${h.healthy ? `healthy pid=${h.pid}` : `dead (${h.why})`} server=${devServerLine()}`,
    );
    process.exit(0);
  }
  // Daemon mode — double-fork (the keep-dev-up pattern). R105 correctness
  // applies here too: the detached child runs ONLY the daemon; nothing else
  // spawns, so there is no per-generation spawn chain.
  if (process.argv.includes("--stage2")) {
    await daemon();
  } else {
    const intermediate = spawn(process.execPath, [__filename, "--stage2"], {
      detached: true,
      stdio: "ignore",
    });
    intermediate.on("exit", () => process.exit(0));
    intermediate.unref();
  }
}

main().catch((e) => {
  wlogEvent(`watchdog crashed: ${e && e.message}`, { kind: "watchdog-crash" });
  process.exit(1);
});

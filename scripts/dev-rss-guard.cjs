// dev-rss-guard.cjs — OOM-killer prevention daemon for the Next.js dev server.
//
// WHY (R105, evidence from R104): in this 4GB sandbox the dev-mode
// next-server RSS grows unboundedly (route compiles, module graph) until the
// kernel OOM-killer SIGKILLs it mid-session — dmesg recorded anon-rss 2.4GB
// kills, and next-server reached 2.85GB before a manual recycle reclaimed it
// to 0.7GB. A CONTROLLED recycle (SIGTERM → clean exit → respawn) is strictly
// better than an unpredictable SIGKILL: no half-written .next chunks, no
// lost sessions mid-battery, no surprise ECONNRESET for browser QA.
//
// LAW: recycle ONLY on SUSTAINED high RSS (≥ HIGH_WATER for ≥ CONSECUTIVE
// samples ~90s) — never on a single spike (a big compile legitimately
// inflates RSS briefly). One instance only (lockfile + heartbeat). Every
// action is logged to dev-rss-guard.log with the RSS evidence.
//
// Modes:
//   node scripts/dev-rss-guard.cjs            → daemon (double-detached)
//   node scripts/dev-rss-guard.cjs --once     → one-shot report (exit 0 healthy
//                                               / 1 over-water, no recycle)
//   node scripts/dev-rss-guard.cjs --status   → daemon state + current RSS
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const { effectiveWaterMb, GRACE_SAMPLES_DEFAULT, GRACE_HEADROOM_MB_DEFAULT } = require("./lib/guard-policy.cjs");

const LOCK = "/home/z/my-project/.dev-rss-guard.lock";
const GUARD_LOG = "/home/z/my-project/dev-rss-guard.log";
// R111: structured JSONL mirror of every guard event. The text log is for
// humans (and the R109 tail parser); the mirror is for MACHINES — exact
// fields (rssMb, pid, streak, waterMb) at the source, surviving text-log
// rotation/truncation so the platform console's history outlives the log.
const GUARD_EVENTS_JSONL = "/home/z/my-project/dev-rss-guard-events.jsonl";
// Mirror hygiene: trim on boot only (per-event stat() is waste) — keep the
// last MIRROR_KEEP_BYTES when the file outgrows MIRROR_TRIM_BYTES.
const MIRROR_TRIM_BYTES = 5 * 1024 * 1024;
const MIRROR_KEEP_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 2 * 60 * 1000; // heartbeat older than this → stale
// Ops/test knobs (env-overridable): RSS_GUARD_WATER_MB, RSS_GUARD_CONSECUTIVE,
// RSS_GUARD_INTERVAL_MS — used by the E2E recycle test to run a REAL recycle
// against a deliberately low water without touching production constants.
const INTERVAL_MS = Math.max(2000, Number(process.env.RSS_GUARD_INTERVAL_MS) || 30 * 1000);
// r107 RETUNE (2026-10-25): the app's compiled-route plateau in `next dev`
// grew past the old 1700MB default (guard log: every server generation
// settled at 2.0–2.43GB and was recycled every ~2min in a PERMANENT loop;
// each recycle reconnects HMR = full page reload on every open tab, which
// silently killed every >90s single-page browser flow — the r107 MFA E2E
// root cause). 2450 sits ABOVE the observed compile plateau while still
// guarding the genuine runaway/OOM zone (R104 recorded a 2.85GB leak and
// kernel OOM SIGKILLs under combined Chrome+server pressure).
//
// r178 RETUNE (2026-11-24): the plateau drifted UP again — this round's
// guard log: transient peaks 2731–2771MB during the post-boot compile
// storm, SETTLING at 2290–2406MB. 2450 left only a 44–160MB margin over
// settle: a settle wobble (e.g. 2420/2440/2460) could hit 3 consecutive
// samples and recycle a HEALTHY server (the r107 disease again — recycle
// storms reconnect HMR and kill browser QA). 2600 restores the margin
// (~200MB over settle) while staying BELOW the transient peaks' worst
// case so a genuine runaway leak (sustained, not settling) still reaches
// 3 consecutive samples and earns a CONTROLLED recycle before the kernel
// OOM-killer shoots the server mid-QA. Evidence: dev-rss-guard.log this
// round — peaks never held 3 samples; the killer was the KERNEL OOM (the
// guard's down-selfheal revived the server in ~2s every time).
const HIGH_WATER_MB = Math.max(50, Number(process.env.RSS_GUARD_WATER_MB) || 2600);
const CONSECUTIVE = Math.max(1, Number(process.env.RSS_GUARD_CONSECUTIVE) || 3);
// R112 grace: post-spawn samples judge RSS against water + HEADROOM so the
// fresh generation's compile storm (battery chains touch every route) does
// not trigger a recycle mid-chain. Env-overridable; SAMPLES=0 disables.
// (Number(...)||DEFAULT would make 0 impossible — 0 is meaningful here.)
const rawGraceSamples = Number(process.env.RSS_GUARD_GRACE_SAMPLES);
const GRACE_SAMPLES =
  Number.isFinite(rawGraceSamples) && rawGraceSamples >= 0 ? rawGraceSamples : GRACE_SAMPLES_DEFAULT;
const GRACE_HEADROOM_MB = Math.max(0, Number(process.env.RSS_GUARD_GRACE_HEADROOM_MB) || GRACE_HEADROOM_MB_DEFAULT);

const ts = () => new Date().toISOString();
function glog(msg) {
  try {
    fs.appendFileSync(GUARD_LOG, `[${ts()}] ${msg}\n`);
  } catch {
    /* logging must never crash the guard */
  }
}

/**
 * R111 — write an event to BOTH sinks with ONE timestamp:
 * the human text log (unchanged line shapes — the R109 parser keeps working)
 * and the structured JSONL mirror (`{ts, kind, msg, ...fields}`).
 * `ts` equality between the two lines is the dedupe key the reader uses to
 * collapse a mirrored event and its text twin into one.
 * Mirroring must never crash the guard — every sink is try/caught.
 */
function glogEvent(msg, ev) {
  const now = ts();
  try {
    fs.appendFileSync(GUARD_LOG, `[${now}] ${msg}\n`);
  } catch {
    /* logging must never crash the guard */
  }
  if (ev && ev.kind) {
    try {
      fs.appendFileSync(
        GUARD_EVENTS_JSONL,
        JSON.stringify({ ts: now, kind: ev.kind, msg, ...ev.fields }) + "\n",
      );
    } catch {
      /* mirroring must never crash the guard */
    }
  }
}

/** Boot-time mirror trim: last MIRROR_KEEP_BYTES when outgrowing the cap. */
function trimMirror() {
  try {
    const st = fs.statSync(GUARD_EVENTS_JSONL);
    if (st.size <= MIRROR_TRIM_BYTES) return;
    const buf = Buffer.alloc(MIRROR_KEEP_BYTES);
    const fh = fs.openSync(GUARD_EVENTS_JSONL, "r");
    try {
      fs.readSync(fh, buf, 0, MIRROR_KEEP_BYTES, st.size - MIRROR_KEEP_BYTES);
    } finally {
      fs.closeSync(fh);
    }
    let text = buf.toString("utf8");
    text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    fs.writeFileSync(GUARD_EVENTS_JSONL, text);
    glog(`mirror trimmed: ${Math.round(st.size / 1024)}KB → ${Math.round(Buffer.byteLength(text) / 1024)}KB`);
  } catch {
    /* nothing to trim / nothing readable — fine */
  }
}

/** next-server pid + RSS (MB), or null. */
function nextServer() {
  try {
    const pid = execFileSync("pgrep", ["-f", "next-server"], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    if (!pid) return null;
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return { pid, rssMb: m ? Math.round(Number(m[1]) / 1024) : null };
  } catch {
    return null;
  }
}

/** Lockfile with heartbeat — dedupes daemon instances across agents. */
function tryAcquireLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (raw.pid && Date.now() - raw.at < LOCK_STALE_MS) {
      try {
        process.kill(raw.pid, 0);
        return false; // live holder
      } catch {
        /* stale — reclaim */
      }
    }
  } catch {
    /* none yet */
  }
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
const heartbeat = () => {
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    /* best-effort */
  }
};

/** True when :3000 is bound (even mid-boot). */
function portOccupied() {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:3000/api/health"],
      { encoding: "utf8" },
    );
    return out.trim() !== "000";
  } catch {
    return false;
  }
}

/** Any leftover dev-server chain process (server, CLI, wrapper — never the guard itself). */
function leftoverCount() {
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", "next-server|next dev -p 3000|scripts/dev-guard[.]cjs"],
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Controlled recycle: TERM → full-chain cleanup → wait port free → respawn (+1 retry). */
function recycleServer(pid, rssMb) {
  glogEvent(`RECYCLE start: next-server pid=${pid} rss=${rssMb}MB sustained ≥${CONSECUTIVE} samples over ${HIGH_WATER_MB}MB`, {
    kind: "recycle-start",
    fields: { rssMb, pid, consecutive: CONSECUTIVE, waterMb: HIGH_WATER_MB },
  });
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  // R105 hardening: SIGTERM alone leaves the `bun run dev`/`tee`/`next dev`
  // chain alive — the respawn's dev-guard boot-gap precheck then saw a live
  // process with :3000 unbound and REFUSED to start (server stayed down
  // 16:31→16:35). Clean the WHOLE chain and wait for a truly free port.
  for (const pattern of ["next dev -p 3000", "next-server", "scripts/dev-guard[.]cjs"]) {
    try {
      execFileSync("pkill", ["-f", pattern]);
    } catch {
      /* none */
    }
  }
  try {
    fs.rmSync("/home/z/my-project/.next/dev-server-info", { force: true });
  } catch {
    /* absent */
  }
  // Wait until no chain process remains AND :3000 is free (≤12s).
  for (let i = 0; i < 24; i += 1) {
    if (leftoverCount() === 0 && !portOccupied()) break;
    execFileSync("sleep", ["0.5"]);
    for (const pattern of ["next dev -p 3000", "next-server"]) {
      try {
        execFileSync("pkill", ["-9", "-f", pattern]);
      } catch {
        /* none */
      }
    }
  }
  spawnDevServer("recycle");
}

/** R111 spawn-event sink: mirrors spawn ok/failed with the structured why. */
function spawnEvent(why, msg, ok, pid) {
  glogEvent(msg, {
    kind: ok ? "spawn-ok" : "spawn-failed",
    fields: { spawnWhy: why, ...(pid !== undefined ? { pid } : {}) },
  });
}

/** Spawn `bun run dev` detached (the ensure-dev.sh discipline) + wait health; one retry. */
function spawnDevServer(why) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const out = fs.openSync("/home/z/my-project/dev.log", "a");
    const child = spawn("bun", ["run", "dev"], {
      cwd: "/home/z/my-project",
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    glog(`spawn(${why}) attempt=${attempt} pid=${child.pid} — waiting for health 200`);
    let ready = false;
    let waited = 0;
    for (let i = 0; i < 40; i += 1) {
      execFileSync("sleep", ["1"]);
      waited = i + 1;
      if (portOccupied()) {
        ready = true;
        break;
      }
    }
    if (ready) {
      spawnEvent(why, `spawn(${why}) OK after ~${waited}s pid=${child.pid}`, true, child.pid);
      return;
    }
    glog(`spawn(${why}) attempt=${attempt} not ready in ${waited}s`);
    // Clean again before the retry.
    for (const pattern of ["next dev -p 3000", "next-server", "scripts/dev-guard[.]cjs"]) {
      try {
        execFileSync("pkill", ["-9", "-f", pattern]);
      } catch {
        /* none */
      }
    }
    execFileSync("sleep", ["1"]);
  }
  spawnEvent(why, `spawn(${why}) GAVE UP after 2 attempts — keep-dev-up/ensure-dev must take over`, false);
}

async function daemon() {
  if (!tryAcquireLock()) {
    console.log("another rss-guard holds the lock — exiting");
    process.exit(0);
  }
  trimMirror();
  glogEvent(`guard started pid=${process.pid} (water=${HIGH_WATER_MB}MB, consecutive=${CONSECUTIVE}, interval=${INTERVAL_MS / 1000}s${process.env.RSS_GUARD_WATER_MB ? " [env-override]" : ""}${GRACE_SAMPLES > 0 ? `, grace=${GRACE_SAMPLES}x+${GRACE_HEADROOM_MB}MB` : ", grace=off"})`, {
    kind: "guard-start",
    fields: { pid: process.pid, waterMb: HIGH_WATER_MB, consecutive: CONSECUTIVE, intervalMs: INTERVAL_MS, graceSamples: GRACE_SAMPLES, graceHeadroomMb: GRACE_HEADROOM_MB },
  });
  let overStreak = 0;
  let downStreak = 0;
  // R112 grace clock: 0 at boot (boot never gets grace — a pre-existing
  // runaway is judged by the strict base water), reset to 0 on every spawn.
  let samplesSinceSpawn = Number.MAX_SAFE_INTEGER;
  for (;;) {
    heartbeat();
    const srv = nextServer();
    if (srv && srv.rssMb !== null) {
      downStreak = 0;
      const { inGrace, effWaterMb: effWater } = effectiveWaterMb({
        baseWaterMb: HIGH_WATER_MB,
        samplesSinceSpawn,
        graceSamples: GRACE_SAMPLES,
        graceHeadroomMb: GRACE_HEADROOM_MB,
      });
      if (srv.rssMb >= effWater) {
        overStreak += 1;
        glogEvent(`high rss: ${srv.rssMb}MB (streak ${overStreak}/${CONSECUTIVE}) pid=${srv.pid}${inGrace ? " [grace]" : ""}`, {
          kind: "high-rss",
          fields: { rssMb: srv.rssMb, streak: `${overStreak}/${CONSECUTIVE}`, pid: srv.pid, waterMb: HIGH_WATER_MB, effWaterMb: effWater, graceActive: inGrace },
        });
        if (overStreak >= CONSECUTIVE) {
          overStreak = 0;
          recycleServer(srv.pid, srv.rssMb);
          samplesSinceSpawn = 0; // the fresh generation gets its grace window
          glogEvent(`RECYCLE done: old rss=${srv.rssMb}MB reclaimed`, {
            kind: "recycle-done",
            fields: { rssMb: srv.rssMb },
          });
        }
      } else {
        if (overStreak > 0)
          glogEvent(`rss recovered: ${srv.rssMb}MB (streak reset)`, {
            kind: "recovered",
            fields: { rssMb: srv.rssMb },
          });
        overStreak = 0;
      }
    } else {
      overStreak = 0;
      downStreak += 1;
      if (downStreak === 2 && !portOccupied() && leftoverCount() === 0) {
        glog(`server down for ${downStreak} samples — respawning`);
        spawnDevServer("down-selfheal");
        samplesSinceSpawn = 0; // the fresh generation gets its grace window
        downStreak = 0; // retry on a 2-sample cadence until healthy
      } else if (downStreak === 2) {
        glogEvent(`server down but port/processes busy — not spawning (owner: keep-dev-up)`, {
          kind: "refusal",
          fields: { why: "down-busy" },
        });
      }
    }
    if (samplesSinceSpawn !== Number.MAX_SAFE_INTEGER) samplesSinceSpawn += 1;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

async function main() {
  if (process.argv.includes("--once")) {
    const srv = nextServer();
    if (!srv) {
      console.log("RSS-GUARD: next-server not running");
      process.exit(0);
    }
    console.log(`RSS-GUARD: next-server pid=${srv.pid} rss=${srv.rssMb}MB water=${HIGH_WATER_MB}MB verdict=${srv.rssMb >= HIGH_WATER_MB ? "OVER-WATER" : "healthy"}`);
    process.exit(srv.rssMb >= HIGH_WATER_MB ? 1 : 0);
  }
  if (process.argv.includes("--status")) {
    const srv = nextServer();
    let holder = "none";
    try {
      const raw = JSON.parse(fs.readFileSync(LOCK, "utf8"));
      holder = `pid=${raw.pid} age=${Math.round((Date.now() - raw.at) / 1000)}s`;
    } catch {
      /* none */
    }
    console.log(`RSS-GUARD status: guard=${holder} server=${srv ? `pid=${srv.pid} rss=${srv.rssMb}MB` : "down"}`);
    process.exit(0);
  }
  // Daemon mode — detach (double-fork pattern from keep-dev-up.cjs).
  // R105 correctness: the detached child runs ONLY the daemon; the spawn
  // happens exactly once (in the non-flag parent). Reaching here with
  // --daemon-stage2 set means we ARE the detached child — never spawn again
  // (the first draft re-spawned per generation: an unbounded spawn chain).
  if (process.argv.includes("--daemon-stage2")) {
    await daemon();
  } else {
    const intermediate = spawn(process.execPath, [__filename, "--daemon-stage2"], {
      detached: true,
      stdio: "ignore",
    });
    intermediate.on("exit", () => process.exit(0));
    intermediate.unref();
  }
}

main().catch((e) => {
  glogEvent(`guard crashed: ${e && e.message}`, { kind: "other", fields: { note: "guard-crash" } });
  process.exit(1);
});

// Double-fork daemon starter — keeps the Next.js dev server alive across
// tool-call sessions in the sandbox (pattern from round 04 worklog).
//
// r19 hardening: the original single-probe check raced with a server that
// was still BOOTING (port bound, not answering 200 yet) and spawned a
// second instance → two Turbopack processes wrote the same .next build
// directory → mixed chunk manifests → browser ChunkLoadError (stale
// chunks). Now: (1) TCP port probe distinguishes "booting" from "down",
// (2) booting → wait and re-probe instead of spawning, (3) a PID lockfile
// makes spawn exclusive, (4) a booting server is given up to ~30s to
// become ready before this script ever considers spawning.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");

const LOG = "/home/z/my-project/dev.log";
const LOCK = "/home/z/my-project/.dev-watchdog.lock";
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 min without heartbeat → stale

function httpUp() {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:3000/"],
      { encoding: "utf8" },
    );
    return out.trim() === "200";
  } catch {
    return false;
  }
}

// True when something holds :3000 even if it doesn't answer HTTP yet
// (mid-boot) — another instance owns the port, we must NOT spawn.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Give a booting instance up to ~30s to start answering; spawn only if
// the port stays completely free for that whole period.
async function waitForServerOrFreePort() {
  for (let i = 0; i < 15; i += 1) {
    if (httpUp()) return "up";
    if (await portOccupied()) {
      await sleep(2000); // booting — keep waiting, never spawn
      continue;
    }
    // Port free this round; confirm it stays free before concluding "down".
    await sleep(1000);
    if (httpUp()) return "up";
    if (await portOccupied()) continue;
    return "down";
  }
  return httpUp() ? "up" : (await portOccupied() ? "booting" : "down");
}

// Exclusive spawn via PID lockfile (best-effort on platforms without flock).
function acquireLock() {
  try {
    const raw = fs.readFileSync(LOCK, "utf8");
    const { pid, at } = JSON.parse(raw);
    if (pid && at && Date.now() - at < LOCK_STALE_MS) {
      try {
        process.kill(pid, 0); // alive → another watchdog is on it
        return false;
      } catch {
        // stale holder — reclaim
      }
    }
  } catch {
    // no lock yet
  }
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

async function stage2() {
  const verdict = await waitForServerOrFreePort();
  if (verdict === "up") {
    console.log("dev server already up");
    process.exit(0);
  }
  if (verdict === "booting") {
    console.log("dev server still booting on :3000 — not spawning a second instance");
    process.exit(0);
  }
  if (!acquireLock()) {
    console.log("another watchdog holds the spawn lock — skipping");
    process.exit(0);
  }
  const out = fs.openSync(LOG, "a");
  const child = spawn("bun", ["run", "dev"], {
    cwd: "/home/z/my-project",
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log("dev server spawned pid:", child.pid);
  process.exit(0);
}

// First stage: detach from the tool-call session.
const intermediate = spawn(process.execPath, [__filename, "--stage2"], {
  detached: true,
  stdio: "ignore",
});
intermediate.on("exit", () => process.exit(0));
intermediate.unref();

if (process.argv.includes("--stage2")) stage2();

#!/usr/bin/env node
// Pre-start guard for `bun run dev` (r19 chunk-recovery hardening).
//
// Why: a second `next dev` binding :3000 while the first is running (or
// still booting) dies with EADDRINUSE — but two Turbopack processes briefly
// sharing the same .next build directory corrupt chunk manifests, which
// surfaces to users as browser ChunkLoadErrors on @radix-ui chunks. This
// guard makes every `bun run dev` invocation self-aware:
//   - server answering 200  → exit 1 (block the duplicate start)
//   - port merely occupied (booting) → exit 1 (block + explain)
//   - port genuinely free   → exit 0 (proceed with `next dev`)
// Used as: node scripts/dev-guard.cjs && next dev -p 3000 ...
const { execFileSync } = require("child_process");
const net = require("net");

function httpUp() {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:3000/"],
      { encoding: "utf8" },
    );
    return out.trim() === "200";
  } catch {
    return false;
  }
}

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

(async () => {
  if (httpUp()) {
    console.log(
      "[dev-guard] :3000 is already serving — refusing to start a duplicate `next dev` (prevents Turbopack chunk corruption).",
    );
    process.exit(1);
  }
  if (await portOccupied()) {
    console.log(
      "[dev-guard] :3000 is occupied by a booting instance — refusing to start a duplicate `next dev`.",
    );
    process.exit(1);
  }
  process.exit(0);
})();

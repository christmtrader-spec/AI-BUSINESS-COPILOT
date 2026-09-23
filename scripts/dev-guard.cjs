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

// r21 hardening — closes the bind-gap race: a `next dev` process exists for
// 1-3s BEFORE its worker binds :3000 (two watchdogs/agents racing produced
// exactly this duplicate on 2026-09-23). If any real Next dev process is
// alive — the `next dev` CLI (node_modules/.bin/next) or a `next-server`
// worker — refuse to start even when the port is not bound yet. The bash
// wrapper is NOT matched (its cmdline only has "next dev" after `&&`).
function nextDevProcessRunning() {
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", "node_modules/[.]bin/next dev|next-server "],
      { encoding: "utf8" },
    );
    return out.trim().length > 0;
  } catch {
    return false; // pgrep exit 1 → no match
  }
}

// r21 env sanity: `.env` is recreated by sandbox refreshes (it happened:
// NEXTAUTH_URL/APP_BASE_URL vanished → password reset 503 with only a
// generic ROUTE error to show for it). Fail the start LOUDLY in dev when
// the two base-URL keys are gone so the regression is caught in seconds,
// not by a harness much later. DATABASE_URL absence is fatal (db-guard
// already covers runtime), the base-URL keys only warn.
function checkEnvSanity() {
  try {
    const env = require("fs").readFileSync("/home/z/my-project/.env", "utf8");
    if (!/^NEXTAUTH_URL=/m.test(env) && !/^APP_BASE_URL=/m.test(env)) {
      console.log(
        "[dev-guard] WARNING: .env has neither NEXTAUTH_URL nor APP_BASE_URL — password-reset delivery will 503. Restore them (see .env.example).",
      );
    }
    if (!/^NEXTAUTH_SECRET=/m.test(env)) {
      console.log(
        "[dev-guard] WARNING: .env has no NEXTAUTH_SECRET — dev fallback secret is in use (sessions reset on restart).",
      );
    }
  } catch {
    console.log("[dev-guard] WARNING: .env not readable — check DATABASE_URL etc.");
  }
}

(async () => {
  checkEnvSanity();
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
  if (nextDevProcessRunning()) {
    console.log(
      "[dev-guard] a `next dev`/`next-server` process is alive but :3000 is not bound yet (boot gap) — refusing to start a duplicate.",
    );
    process.exit(1);
  }
  process.exit(0);
})();

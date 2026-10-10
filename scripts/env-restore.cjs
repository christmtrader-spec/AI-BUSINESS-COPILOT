#!/usr/bin/env node
// Self-healing `.env` restorer (r26).
//
// Why: sandbox refreshes periodically recreate `.env` with ONLY DATABASE_URL
// (it happened again on 2026-09-26: NEXTAUTH_SECRET/NEXTAUTH_URL/
// APP_BASE_URL vanished → password-reset delivery 503'd and sessions would
// reset on the next restart). dev-guard previously only WARNED — that left
// the running process on a broken env until a human noticed a harness
// failure many steps later.
//
// What it does: compares `.env` against `.env.backup` (a full known-good
// copy). Any REQUIRED key missing from `.env` but present in the backup is
// merged back in. Keys already present in `.env` are NEVER overwritten —
// intentional local edits always win. Exits 0 always (restore is best-
// effort; hard failures print a warning and return non-fatally).
//
// Usage: node scripts/env-restore.cjs   (called by dev-guard + keep-dev-up)

const fs = require("fs");

const ENV_PATH = "/home/z/my-project/.env";
const BACKUP_PATH = "/home/z/my-project/.env.backup";

// Keys without which core flows break:
//  - DATABASE_URL      → nothing works (db-guard covers runtime)
//  - NEXTAUTH_SECRET   → sessions reset on every restart (dev fallback)
//  - NEXTAUTH_URL/APP_BASE_URL → password-reset 503 (appBaseUrl())
const REQUIRED_KEYS = ["DATABASE_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "APP_BASE_URL"];

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function serializeEnv(map) {
  // Preserve insertion order; simple KEY=VALUE lines (values are URLs /
  // secrets without newlines — matches every value this project stores).
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
}

function restore() {
  let envText;
  try {
    envText = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    console.log("[env-restore] WARNING: .env unreadable — cannot restore");
    return 1;
  }

  let backupText;
  try {
    backupText = fs.readFileSync(BACKUP_PATH, "utf8");
  } catch {
    // No backup: fall back to warning-only (previous behavior).
    const env = parseEnv(envText);
    const missing = REQUIRED_KEYS.filter((k) => !env.has(k) || env.get(k).trim() === "");
    if (missing.length > 0) {
      console.log(
        `[env-restore] WARNING: .env missing [${missing.join(", ")}] and no .env.backup exists — restore manually (see .env.example)`,
      );
      return 1;
    }
    return 0;
  }

  const env = parseEnv(envText);
  const backup = parseEnv(backupText);
  const missing = REQUIRED_KEYS.filter((k) => !env.has(k) || env.get(k).trim() === "");
  if (missing.length === 0) return 0;

  const restorable = missing.filter((k) => backup.has(k) && backup.get(k).trim() !== "");
  if (restorable.length === 0) {
    console.log(
      `[env-restore] WARNING: .env missing [${missing.join(", ")}] but backup lacks them too — restore manually`,
    );
    return 1;
  }

  for (const key of restorable) env.set(key, backup.get(key));
  try {
    fs.writeFileSync(ENV_PATH, serializeEnv(env));
    console.log(`[env-restore] RESTORED missing keys [${restorable.join(", ")}] from .env.backup`);
    return 0;
  } catch (e) {
    console.log(`[env-restore] WARNING: could not write .env (${e.message})`);
    return 1;
  }
}

process.exit(restore());

#!/usr/bin/env node
/**
 * scripts/prompt29-check.mjs — Prompt 29 production-operations harness.
 *
 * Runs against a LIVE dev server (default http://localhost:3000) + the P29
 * operational scripts, asserting §127-§149:
 *
 *   Email (§127/§128/§130/§131): reset E2E via the dev transport, enumeration
 *     parity, token hashing, send-before-persist semantics, template hardening.
 *   Observability (§132/§133/§134): X-Request-ID on 400/401/403/404/429,
 *     structured api.request.failed events in dev.log with NO secrets,
 *     client-id echo, malformed/oversized id replacement.
 *   Health/Readiness (§137/§138/§93): liveness minimal, readiness component
 *     states honest, no internal details exposed.
 *   Backup/Restore (§139-§143): scratch-DB backup + checksum + metadata,
 *     corruption detection, restore drill PASS, production-restore refusal,
 *     public backup-leak scan.
 *   Preflight (§144): config-check failure paths, gate refusal without
 *     backup, release-preflight, caddy contract.
 *   Hardening (§147/§148/§149): rate-limit bounds (unit), security headers
 *     live, caddy proxy path + spoof protection contract.
 *
 * Usage:  node scripts/prompt29-check.mjs [baseUrl]
 * Exit:   0 = all green · 1 = failures
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = "/home/z/my-project";
const BASE = process.argv[2] ?? "http://localhost:3000";
const DEVLOG = join(ROOT, "dev.log");
const STAMP = Date.now();
const TEST_IP = `10.209.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
const logSizeAtStart = existsSync(DEVLOG) ? statSync(DEVLOG).size : 0;

const require = createRequire(import.meta.url);
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const line = readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith("DATABASE_URL="));
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ HTTP helpers ------------------------------ */

function newJar() {
  const cookies = new Map();
  return {
    capture(res) {
      const raw = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "); },
    get(nameSuffix) { for (const [k, v] of cookies) if (k.endsWith(nameSuffix)) return v; return null; },
  };
}

async function rawFetch(path, { method = "GET", body, headers = {}, jar, ip = TEST_IP } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": ip,
      ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (jar) jar.capture(res);
  const requestId = res.headers.get("x-request-id");
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, requestId };
}

async function login(email, password, ip = TEST_IP) {
  const jar = newJar();
  await rawFetch("/api/auth/csrf", { jar, ip });
  const rawCookie = jar.get("csrf-token");
  const csrfToken = rawCookie ? decodeURIComponent(rawCookie).split("|")[0] : null;
  await rawFetch("/api/auth/callback/credentials", {
    method: "POST", jar, ip,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/`, json: "true" }).toString(),
  });
  if (!jar.get("session-token")) throw new Error(`login failed for ${email}`);
  return jar;
}

async function registerUser(name, ip = TEST_IP) {
  const email = `${name}-${STAMP}@p29check.local`;
  const password = "Prompt29-Test-2026";
  const res = await rawFetch("/api/v1/auth/register", {
    method: "POST", ip,
    body: { name: `QA ${name}`, email, password },
  });
  if (res.status !== 201) throw new Error(`register ${name}: ${res.status} ${res.text.slice(0, 100)}`);
  return { email, password };
}

function newDevlogLines() {
  if (!existsSync(DEVLOG)) return "";
  const buf = Buffer.alloc(Math.min(statSync(DEVLOG).size - logSizeAtStart > 0 ? statSync(DEVLOG).size - logSizeAtStart : 0, 4_000_000));
  if (buf.length === 0) return "";
  const fd = require("node:fs").openSync(DEVLOG, "r");
  require("node:fs").readSync(fd, buf, 0, buf.length, logSizeAtStart);
  require("node:fs").closeSync(fd);
  return buf.toString("utf8");
}

function lastResetTokenFromLog() {
  const content = newDevlogLines();
  const matches = [...content.matchAll(/#\/reset-password\/([A-Za-z0-9_-]{43})/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function runScript(script, args = [], envPatch = {}) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
    encoding: "utf8",
    timeout: 180_000,
    cwd: ROOT,
    env: { ...process.env, ...envPatch },
  });
}

console.log(`\nPrompt 29 production-operations harness — target ${BASE}`);
console.log(`test ip: ${TEST_IP}`);

try {
  /* ================= EMAIL: password reset E2E (§127/§13/§14) ============= */
  console.log("\n-- email: production-safe reset flow (§127)");
  const p29user = await registerUser("resetflow");
  const resetIp = TEST_IP; // same run ip is fine: 1 request against limit 5
  const reqRes = await rawFetch("/api/v1/auth/password-reset/request", {
    method: "POST", ip: resetIp,
    body: { email: p29user.email },
  });
  check("reset:request-generic-200", reqRes.status === 200 && !!reqRes.json?.data?.message?.includes("If an account exists"), `status=${reqRes.status}`);
  check("reset:request-carries-request-id", typeof reqRes.requestId === "string" && reqRes.requestId.length >= 8, reqRes.requestId ?? "missing");
  await sleep(600);
  const rawToken = lastResetTokenFromLog();
  check("reset:dev-transport-delivered", !!rawToken, "reset link found in dev console transport");
  if (rawToken) {
    const dbToken = await prisma.passwordResetToken.findFirst({
      where: { user: { email: p29user.email } },
      orderBy: { createdAt: "desc" },
    });
    check("reset:token-persisted-after-send", !!dbToken, "token row exists (send-before-persist §13)");
    check("reset:token-hashed-only", !!dbToken && /^[a-f0-9]{64}$/.test(dbToken.tokenHash) && dbToken.tokenHash !== rawToken, "sha256 hex, never raw (§14)");
    // §13 — one live token per user; confirm old session invalidation + new login.
    const oldSession = await login(p29user.email, p29user.password);
    const meBefore = await rawFetch("/api/v1/me", { jar: oldSession });
    check("reset:old-session-valid-before", meBefore.status === 200, `status=${meBefore.status}`);
    const confirmRes = await rawFetch("/api/v1/auth/password-reset/confirm", {
      method: "POST", ip: resetIp,
      body: { token: rawToken, newPassword: "Prompt29-NewPass-2026", confirmPassword: "Prompt29-NewPass-2026" },
    });
    check("reset:confirm-ok", confirmRes.status === 200, `status=${confirmRes.status} ${confirmRes.text.slice(0, 80)}`);
    const meAfter = await rawFetch("/api/v1/me", { jar: oldSession });
    check("reset:old-session-invalidated", meAfter.status === 401, `status=${meAfter.status}`);
    const newLogin = await login(p29user.email, "Prompt29-NewPass-2026");
    const meNew = await rawFetch("/api/v1/me", { jar: newLogin });
    check("reset:new-login-succeeds", meNew.status === 200, `status=${meNew.status}`);
    const reuse = await rawFetch("/api/v1/auth/password-reset/confirm", {
      method: "POST", ip: resetIp,
      body: { token: rawToken, newPassword: "Prompt29-Again-2026", confirmPassword: "Prompt29-Again-2026" },
    });
    check("reset:token-single-use", reuse.status !== 200, `status=${reuse.status}`);
  }

  /* ================= ENUMERATION PARITY (§128/§12) ======================== */
  console.log("\n-- email: enumeration parity (§128)");
  const enumIp = `10.209.77.${Math.floor(Math.random() * 200) + 10}`;
  const known = await rawFetch("/api/v1/auth/password-reset/request", {
    method: "POST", ip: enumIp, body: { email: p29user.email },
  });
  const unknown = await rawFetch("/api/v1/auth/password-reset/request", {
    method: "POST", ip: enumIp, body: { email: `ghost-${STAMP}@p29check.local` },
  });
  check("enum:known-200", known.status === 200, `status=${known.status}`);
  check("enum:unknown-200", unknown.status === 200, `status=${unknown.status}`);
  check("enum:identical-body", known.text === unknown.text, "byte-identical generic response");
  check("enum:no-existence-hint", !known.text.includes("sent") === !unknown.text.includes("sent"), "same copy both sides");

  /* ============ SEND-BEFORE-PERSIST static contract (§13) ================= */
  console.log("\n-- email: send-before-persist contract (§13)");
  {
    const src = readFileSync(join(ROOT, "src/app/api/v1/auth/password-reset/request/route.ts"), "utf8");
    const sendIdx = src.indexOf("await provider.send(message)");
    const persistIdx = src.indexOf("await db.passwordResetToken.create(");
    check("reset:send-precedes-persist", sendIdx > 0 && persistIdx > sendIdx, "token row created only after successful send");
    const failureReturn = src.includes("return genericResponse();") && src.includes("NO token persisted");
    check("reset:failure-persists-nothing", failureReturn, "delivery failure returns generic 200 without token row");
  }

  /* ============== OBSERVABILITY: status codes + correlation (§132) ======== */
  console.log("\n-- observability: correlation across statuses (§132/§133/§134)");
  {
    const bad400 = await rawFetch("/api/v1/auth/password-reset/request", {
      method: "POST", ip: `10.209.88.11`, body: "{not json", headers: { "content-type": "application/json" },
    });
    check("obs:400-request-id", bad400.status === 400 && !!bad400.requestId, `status=${bad400.status} id=${bad400.requestId}`);
    check("obs:400-no-stack", !bad400.text.includes("at ") || !bad400.text.includes(".ts:"), "no stack trace in body");

    const unauth401 = await rawFetch("/api/v1/me");
    check("obs:401-request-id", unauth401.status === 401 && !!unauth401.requestId, `id=${unauth401.requestId}`);

    // 403: authenticated tenant user calling a platform endpoint.
    const tenant = await registerUser("obs403");
    const tjar = await login(tenant.email, tenant.password);
    const forbidden = await rawFetch("/api/v1/platform/overview", { jar: tjar });
    check("obs:403-request-id", forbidden.status === 403 && !!forbidden.requestId, `status=${forbidden.status} id=${forbidden.requestId}`);

    // §85 — 404 via the wrapper. The invites probe route 404s for a valid
    // session regardless of business scope (fresh tenants have none, and the
    // dev DB is at its BUSINESSES_MAX headroom — do not create fixtures).
    const notFound = await rawFetch("/api/v1/invites/nonexistent-token-p29-probe", { jar: tjar });
    check("obs:404-request-id", notFound.status === 404 && !!notFound.requestId, `status=${notFound.status} id=${notFound.requestId}`);

    // 429: exhaust the per-email reset budget (limit 3/hour) from a fresh IP.
    const floodIp = `10.209.99.${Math.floor(Math.random() * 200) + 10}`;
    let saw429 = null;
    for (let i = 0; i < 5 && !saw429; i++) {
      const r = await rawFetch("/api/v1/auth/password-reset/request", {
        method: "POST", ip: floodIp, body: { email: `flood-${STAMP}@p29check.local` },
      });
      if (r.status === 429) saw429 = r;
      await sleep(30);
    }
    check("obs:429-request-id", !!saw429 && !!saw429.requestId, saw429 ? `id=${saw429.requestId}` : "no 429 observed");

    // Client-supplied id echo + malformed replacement.
    const echo = await rawFetch("/api/ready", { headers: { "x-request-id": "harness-echo-id-12345678" } });
    check("obs:client-id-echoed", echo.requestId === "harness-echo-id-12345678", echo.requestId ?? "missing");
    const replaced = await rawFetch("/api/ready", { headers: { "x-request-id": "x".repeat(300) } });
    check("obs:oversized-id-replaced", !!replaced.requestId && replaced.requestId !== "x".repeat(300) && replaced.requestId.length <= 64, replaced.requestId ?? "missing");

    await sleep(700);
    const logLines = newDevlogLines();
    const failedEvents = [...logLines.matchAll(/\{"ts":[^\n]*"event":"api\.request\.failed"[^\n]*\}/g)].map((m) => m[0]);
    check("obs:structured-api-error-events", failedEvents.length >= 3, `${failedEvents.length} structured events this run`);
    const sample = failedEvents[failedEvents.length - 1] ?? "";
    check("obs:event-has-correlation-fields", sample.includes('"requestId"') && sample.includes('"route"') && sample.includes('"status"') && sample.includes('"errorClass"'), sample.slice(0, 160));
    check("obs:event-no-request-body", !sample.includes("{not json") && !sample.includes("flood-"), "no body/PII in events");
    const rateLimitedEvents = [...logLines.matchAll(/"event":"api\.request\.rate_limited"/g)].length;
    check("obs:rate-limit-event-emitted", rateLimitedEvents >= 1, `${rateLimitedEvents} rate_limited events`);
    // §162 — no secret material anywhere in the new log lines.
    check("obs:no-secrets-in-logs", !logLines.includes("Prompt29-Test-2026") && !logLines.includes("Prompt29-NewPass-2026"), "no passwords in log tail");
    // §14/§162 — the raw reset token may appear ONLY inside the clearly
    // marked DEV console-transport line (dev-only). Every occurrence must
    // be on such a line; production never has that transport.
    if (rawToken) {
      const tokenLines = logLines.split("\n").filter((l) => l.includes(`#/reset-password/${rawToken}`));
      check("obs:raw-token-only-in-dev-transport-line", tokenLines.length >= 1 && tokenLines.every((l) => l.includes("[email:console-transport]")), `${tokenLines.length} occurrence(s), all in dev transport`);
    }
  }

  /* ============== HEALTH / READINESS (§39-42/§90/§93/§137/§138) =========== */
  console.log("\n-- health & readiness (§137/§138/§93)");
  {
    const health = await rawFetch("/api/health");
    check("health:200-ok", health.status === 200 && health.json?.status === "ok", `status=${health.status}`);
    check("health:minimal-fields", !!health.json?.version && typeof health.json?.database?.reachable === "boolean" && Object.keys(health.json).length <= 5, "no internals leaked");
    const ready = await rawFetch("/api/ready");
    const comp = ready.json?.components ?? {};
    check("ready:200-body", ready.status === 200 && ["ready", "degraded", "blocked"].includes(ready.json?.status), ready.json?.status);
    check("ready:db-ready", comp.database === "READY", comp.database);
    check("ready:migrations-ready", comp.migrations === "READY", comp.migrations);
    check("ready:email-honest-not-configured", comp.email === "NOT_CONFIGURED", comp.email);
    check("ready:payments-blocked", comp.payments === "BLOCKED", comp.payments);
    check("ready:ai-rates-not-configured", comp.aiCostRates === "NOT_CONFIGURED", comp.aiCostRates);
    check("ready:legal-requires-review", comp.legal === "REQUIRES_REVIEW", comp.legal);
    check("ready:no-internal-detail", !JSON.stringify(ready.json).includes("migration_name") && !JSON.stringify(ready.json).includes("backups/") && !ready.text.includes("custom.db") && !/@/.test(JSON.stringify(comp)), "no paths/emails/migration names");
    // Ready endpoint answers 200 even when degraded (state in body, §41).
    check("ready:degraded-still-200", ready.json?.status !== "blocked" ? ready.status === 200 : ready.status === 200, "");
  }

  /* ==================== BACKUP: scratch DB round-trip (§139) ============== */
  console.log("\n-- backup: synthetic scratch DB (§139)");
  {
    const scratchDir = join(tmpdir(), `p29-scratch-${STAMP}`);
    mkdirSync(scratchDir, { recursive: true });
    const scratchDb = join(scratchDir, "scratch.db");
    {
      const d = new DatabaseSync(scratchDb);
      d.exec(`CREATE TABLE "_prisma_migrations" (id VARCHAR(36) PRIMARY KEY NOT NULL, checksum VARCHAR(64) NOT NULL, finished_at DATETIME, migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at DATETIME, started_at DATETIME NOT NULL DEFAULT current_timestamp, applied_steps_count INTEGER UNSIGNED NOT NULL DEFAULT 0)`);
      d.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, started_at, finished_at, migration_name, applied_steps_count) VALUES (?,?,?,?,?,1)`).run("u1", "cs", new Date().toISOString(), new Date().toISOString(), "0_init");
      d.exec(`CREATE TABLE t (a INTEGER)`);
      d.prepare(`INSERT INTO t VALUES (?)`).run(42);
      d.close();
    }
    const outDir = join(scratchDir, "backups");
    const backupRes = runScript("backup-db.mjs", [], {
      DATABASE_URL: `file:${scratchDb}`,
      BACKUP_DIR: outDir,
    });
    check("backup:script-exit-0", backupRes.status === 0, (backupRes.stdout + backupRes.stderr).slice(-160));
    const files = existsSync(outDir) ? readdirSync(outDir) : [];
    const dbArtifact = files.find((f) => f.endsWith(".db"));
    const sidecarFile = files.find((f) => f.endsWith(".json"));
    check("backup:artifact-created", !!dbArtifact, files.join(","));
    check("backup:sidecar-created", !!sidecarFile, "");
    if (sidecarFile) {
      const sidecar = JSON.parse(readFileSync(join(outDir, sidecarFile), "utf8"));
      check("backup:sidecar-sha256", /^[a-f0-9]{64}$/.test(sidecar.sha256 ?? ""), "checksum present");
      check("backup:sidecar-integrity-ok", sidecar.integrity?.integrityCheck === "ok" && sidecar.integrity?.foreignKeyViolations === 0, JSON.stringify(sidecar.integrity));
      check("backup:sidecar-migration-count", sidecar.migrationCount === 1, `count=${sidecar.migrationCount}`);
      check("backup:sidecar-no-secrets", !JSON.stringify(sidecar).includes(scratchDir) && !JSON.stringify(sidecar).includes("file:"), "source path masked, no URL");
      check("backup:sidecar-unverified-initially", sidecar.verified === false, "verified=false until verify-backup runs");
      check("backup:naming-safe", /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/.test(dbArtifact ?? ""), "UTC timestamp, no spaces/colons");
    }
    // verify → flips verified
    const verifyRes = runScript("verify-backup.mjs", [join(outDir, dbArtifact)], { BACKUP_DIR: outDir });
    check("backup:verify-pass", verifyRes.status === 0, (verifyRes.stdout + verifyRes.stderr).slice(-120));
    const sidecarAfter = JSON.parse(readFileSync(join(outDir, dbArtifact.replace(/\.db$/, ".json")), "utf8"));
    check("backup:verified-flag-set", sidecarAfter.verified === true, "");

    /* ---------------- corruption detection (§140/§113) ------------------- */
    console.log("\n-- backup: corruption detection (§140)");
    const corruptPath = join(scratchDir, "corrupt.db");
    {
      const raw = Buffer.from(readFileSync(join(outDir, dbArtifact)));
      raw[raw.length - 100] = raw[raw.length - 100] ^ 0xff; // flip a byte
      raw[200] = raw[200] ^ 0x55;
      writeFileSync(corruptPath, raw);
      // sidecar copy so the checksum path is exercised
      const sc = JSON.parse(JSON.stringify(sidecarAfter));
      sc.backupFile = "corrupt.db";
      writeFileSync(join(scratchDir, "corrupt.json"), JSON.stringify(sc, null, 2));
    }
    const corruptRes = runScript("verify-backup.mjs", [corruptPath]);
    check("backup:corruption-FAIL", corruptRes.status === 1 && /MISMATCH|FAIL/i.test(corruptRes.stdout + corruptRes.stderr), `exit=${corruptRes.status}`);

    /* ---------------- restore drill on verified backup (§141/§116) ------- */
    console.log("\n-- restore drill (§141/§116)");
    const drillRes = runScript("restore-drill.mjs", ["--backup", join(outDir, dbArtifact)], { BACKUP_DIR: outDir });
    check("drill:PASS", drillRes.status === 0 && /RESULT:\s+PASS/.test(drillRes.stdout), (drillRes.stdout + drillRes.stderr).slice(-200));
    // §116 — the scratch backup contains a fake "0_init" migration, so the
    // drill MUST NOT declare it current: honest PENDING_MIGRATIONS expected.
    check("drill:older-backup-not-declared-current", /PENDING_MIGRATIONS/.test(drillRes.stdout), "scratch backup honestly reported as predating current migrations");
    // A REAL current backup must be UP_TO_DATE (fresh one from the live DB).
    const realBackup = runScript("backup-db.mjs", [], {});
    if (realBackup.status === 0) {
      const realName = (realBackup.stdout.match(/backup-\S+\.db/) ?? [])[0];
      if (realName) {
        runScript("verify-backup.mjs", [realName], {});
        const drillReal = runScript("restore-drill.mjs", ["--backup", realName], {});
        check("drill:current-backup-UP_TO_DATE", drillReal.status === 0 && /UP_TO_DATE/.test(drillReal.stdout) && /RESULT:\s+PASS/.test(drillReal.stdout), (drillReal.stdout + drillReal.stderr).slice(-120));
      }
    }

    /* --------------- production restore safety (§142/§55) ---------------- */
    console.log("\n-- production restore safety (§142)");
    const realDbPath = loadDatabaseUrl().replace(/^file:/, "").split("?")[0];
    const rejectRes = runScript("restore-drill.mjs", ["--target", realDbPath], { BACKUP_DIR: outDir });
    check("restore:production-REJECTED", rejectRes.status === 2 && /REFUSED/.test(rejectRes.stderr), `exit=${rejectRes.status}`);
    const flagRes = runScript("restore-drill.mjs", ["--target", realDbPath, "--allow-production-restore"], { BACKUP_DIR: outDir });
    check("restore:in-place-NOT-implemented", flagRes.status === 3 && /NOT_IMPLEMENTED/.test(flagRes.stderr), `exit=${flagRes.status}`);

    rmSync(scratchDir, { recursive: true, force: true });
  }

  /* ===================== BACKUP LEAK SCAN (§61-62/§143) =================== */
  console.log("\n-- backup leak scan (§143)");
  {
    const offenders = [];
    const scanDir = (dir, depth = 0) => {
      if (depth > 4 || !existsSync(dir)) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "backups" || e.name === "node_modules" || e.name === ".git") continue;
          scanDir(p, depth + 1);
        } else if (/\.(db|sqlite|sqlite3|bak)$/i.test(e.name) || /backup-.*\.db/.test(e.name)) {
          offenders.push(p.replace(ROOT, ""));
        }
      }
    };
    scanDir(join(ROOT, "public"));
    scanDir(join(ROOT, ".next", "static"));
    const robots = join(ROOT, "public", "robots.txt");
    const robotsSafe = !existsSync(robots) || !/backup|\.db/i.test(readFileSync(robots, "utf8"));
    check("leak:no-db-in-public", offenders.filter((o) => o.startsWith("/public")).length === 0, offenders.slice(0, 3).join(","));
    check("leak:no-db-in-static", offenders.filter((o) => o.startsWith("/.next")).length === 0, "");
    check("leak:robots-clean", robotsSafe, "robots.txt references no backup artifacts");
    // gitignore covers backups + db files (§63)
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    check("leak:gitignore-covers-db", /db\/backups\//.test(gitignore) && /db\/\*\.db/.test(gitignore) && /\.env\*/.test(gitignore), "");
  }

  /* ================= PRODUCTION CONFIG / PREFLIGHT (§144) ================= */
  console.log("\n-- preflight failure paths (§144)");
  {
    const missing = runScript("production-config-check.mjs", [], {
      NODE_ENV: "production",
      DATABASE_URL: "",
      NEXTAUTH_SECRET: "",
      NEXTAUTH_URL: "",
    });
    check("preflight:missing-mandatory-fails", missing.status === 1, `exit=${missing.status}`);
    const invalidUrl = runScript("production-config-check.mjs", [], {
      NODE_ENV: "production",
      DATABASE_URL: loadDatabaseUrl(),
      NEXTAUTH_SECRET: "x".repeat(44),
      NEXTAUTH_URL: "not-a-url",
    });
    check("preflight:invalid-nextauth-url-fails", invalidUrl.status === 1, `exit=${invalidUrl.status}`);
    const devOk = runScript("production-config-check.mjs", [], {
      NODE_ENV: "development",
      DATABASE_URL: loadDatabaseUrl(),
      NEXTAUTH_SECRET: "x".repeat(44),
      NEXTAUTH_URL: "http://localhost:3000",
    });
    check("preflight:dev-acceptable", devOk.status === 0, `exit=${devOk.status}`);
    // Migration gate: missing backup dir → refusal
    const gateNoBackup = runScript("production-preflight.mjs", ["--gate"], {
      BACKUP_DIR: join(tmpdir(), `p29-empty-${STAMP}`),
    });
    mkdirSync(join(tmpdir(), `p29-empty-${STAMP}`), { recursive: true });
    const gateNoBackup2 = runScript("production-preflight.mjs", ["--gate"], {
      BACKUP_DIR: join(tmpdir(), `p29-empty-${STAMP}`),
      DATABASE_URL: loadDatabaseUrl(),
    });
    check("preflight:gate-refuses-without-backup", gateNoBackup2.status === 1 && /REFUSED/.test(gateNoBackup2.stdout + gateNoBackup2.stderr), `exit=${gateNoBackup2.status}`);
    const gateOk = runScript("production-preflight.mjs", ["--gate"], {});
    check("preflight:gate-opens-with-verified-backup", gateOk.status === 0 && /OPEN/.test(gateOk.stdout), `exit=${gateOk.status}`);
    const release = runScript("release-preflight.mjs", [], {});
    check("release-preflight:acceptable", release.status === 0, `exit=${release.status}${(release.stdout + release.stderr).slice(-80)}`);
    const caddy = runScript("caddy-config-check.mjs", [], {});
    check("caddy:contract-holds", caddy.status === 0, (caddy.stdout + caddy.stderr).slice(-100));
    rmSync(join(tmpdir(), `p29-empty-${STAMP}`), { recursive: true, force: true });
  }

  /* ================= SECURITY HEADERS (§97/§148) ========================== */
  console.log("\n-- security headers (§148)");
  {
    let res = null;
    for (let i = 0; i < 3 && !res; i++) {
      try { res = await fetch(`${BASE}/`); } catch { await sleep(1500); }
    }
    if (!res) throw new Error("GET / failed after retries (dev server recompiling?)");
    const h = res.headers;
    check("headers:nosniff", h.get("x-content-type-options") === "nosniff", h.get("x-content-type-options") ?? "missing");
    check("headers:referrer-policy", h.get("referrer-policy") === "strict-origin-when-cross-origin", h.get("referrer-policy") ?? "missing");
    check("headers:frame-deny", h.get("x-frame-options") === "DENY", h.get("x-frame-options") ?? "missing");
    check("headers:csp-frame-ancestors", (h.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), h.get("content-security-policy") ?? "missing");
    check("headers:no-hsts-when-no-https", process.env.PUBLIC_BASE_URL ? true : h.get("strict-transport-security") === null, "HSTS only with real HTTPS origin");
    check("headers:permissions-policy", (h.get("permissions-policy") ?? "").includes("camera=()"), h.get("permissions-policy") ?? "missing");
  }

  /* ================= CADDY PROXY PATH (§149) ============================== */
  console.log("\n-- caddy proxy (§149)");
  {
    // The gateway (:81 → app) must forward and the app must answer.
    let proxiedOk = false;
    try {
      const res = await fetch("http://localhost:81/api/health", { headers: { "x-request-id": "caddy-proxy-probe-12345" } });
      proxiedOk = res.status === 200;
    } catch { proxiedOk = false; }
    check("caddy:proxied-request-reaches-app", proxiedOk, "GET :81/api/health 200");
    // Spoof contract: the Caddyfile overwrites XFF (static check above); the
    // direct-to-app XFF trust boundary is documented for dev-only access.
    const src = readFileSync(join(ROOT, "Caddyfile"), "utf8");
    check("caddy:xff-overwritten", (src.match(/header_up\s+X-Forwarded-For\s+\{remote_host\}/g) ?? []).length >= 2, "both proxy blocks overwrite XFF");
  }

  /* ================= GRACEFUL SHUTDOWN (§70/§146) ========================= */
  console.log("\n-- graceful shutdown (§146)");
  {
    // Spawn an isolated process that installs the shutdown handlers via the
    // real instrumentation module (NEXT_RUNTIME=nodejs as Next sets it),
    // then SIGTERM it and require exit 0.
    const child = spawnSync("bun", [
      "--preload", join(ROOT, "scripts/p29-preload.ts"), "-e",
      `process.env.NEXT_RUNTIME = "nodejs"; const m = await import("${join(ROOT, "src/instrumentation-node.ts")}"); await m.register(); console.log("REGISTER-OK"); setTimeout(() => process.kill(process.pid, "SIGTERM"), 300); setInterval(() => {}, 1000);`,
    ], { encoding: "utf8", timeout: 30_000, cwd: ROOT });
    const out = child.stdout + child.stderr;
    check("shutdown:clean-exit-0", out.includes("REGISTER-OK") && child.status === 0, `exit=${child.status} signal=${child.signal}`);
    check("shutdown:structured-events", out.includes('"event":"shutdown.begin"') && out.includes('"event":"shutdown.complete"'), "begin + complete emitted");
  }

  /* ================= DOCS + ENV CONTRACT presence (§163-165) ============== */
  console.log("\n-- docs & env contract (§163-165)");
  {
    for (const f of [
      "docs/deployment/production-operations.md",
      "docs/deployment/release-rollback.md",
      "docs/deployment/first-production-deploy.md",
      "docs/security/observability-and-logging.md",
    ]) {
      check(`docs:${basename(f)}`, existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).size > 500, "present and non-trivial");
    }
    const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const k of ["EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT", "EMAIL_SERVER_USER", "EMAIL_SERVER_PASSWORD", "EMAIL_FROM", "EMAIL_SECURE", "EMAIL_TIMEOUT_MS", "BACKUP_DIR", "BACKUP_MAX_AGE_HOURS", "RESTORE_DRILL_MAX_AGE_DAYS", "BACKUP_RETENTION_DAILY", "BACKUP_RETENTION_WEEKLY", "LOG_LEVEL", "GRACEFUL_SHUTDOWN_TIMEOUT_MS"]) {
      check(`env:${k}`, envExample.includes(`${k}=`), "documented in .env.example");
    }
  }

  /* ============ PAYMENT / AI-RATE / LEGAL SAFETY (§158/§159/§160) ========== */
  console.log("\n-- safety invariants (§158/§159/§160)");
  {
    const envKeys = Object.keys(process.env).filter((k) => k.startsWith("ZARINPAL") || k === "PAYMENTS_ENABLED" || k === "PAYMENT_ENV");
    const paymentsEnabled = (process.env.PAYMENTS_ENABLED ?? "").trim() === "true";
    check("safety:payments-disabled", !paymentsEnabled, "PAYMENTS_ENABLED not true (§177)");
    const realMerchant = ["ZARINPAL_MERCHANT_ID"].every((k) => !process.env[k]);
    check("safety:no-merchant-credentials", realMerchant, "no Zarinpal merchant id present");
    const prodRates = await prisma.aiCostRate.count({ where: { environment: "PRODUCTION" } });
    check("safety:no-production-ai-rate-invented", prodRates === 0, `PRODUCTION rates=${prodRates} (§178)`);
    // Legal docs still require review — no fake approval (§179).
    const privacy = readFileSync(join(ROOT, "src/content/legal/privacy.ts"), "utf8");
    check("safety:legal-review-still-pending", privacy.includes("legalReviewRequired: true"), "no fake legal approval");
    check("safety:no-fake-public-base-url", !(process.env.PUBLIC_BASE_URL ?? "").trim(), "PUBLIC_BASE_URL honestly unset (§160)");
  }

  /* ================ RATE LIMIT LIMITATION DOCS (§74) ====================== */
  console.log("\n-- rate limit posture (§74)");
  {
    const src = readFileSync(join(ROOT, "src/lib/rate-limit.ts"), "utf8");
    check("ratelimit:process-local-documented", src.includes("PROCESS-LOCAL") && src.includes("NO distributed protection"), "§74 documented at the implementation");
    check("ratelimit:bounded-buckets", src.includes("MAX_BUCKETS") && src.includes("MAX_HITS_PER_BUCKET"), "§75 bounds present");
    check("ratelimit:fail-open-safety", src.includes("never crash the application"), "§76 fail-safe present");
  }
} catch (error) {
  failures.push({ name: "harness:unexpected-error", detail: String(error?.stack ?? error).slice(0, 400) });
  console.error("\n✖ harness crashed:", String(error?.stack ?? error).slice(0, 600));
} finally {
  await prisma.$disconnect();
}

console.log(`\n== P29 HARNESS RESULT ${"=".repeat(38)}`);
if (failures.length > 0) {
  console.error(`✖ ${failures.length}/${passed + failures.length} checks FAILED:`);
  for (const f of failures) console.error(`   - ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 160)}` : ""}`);
  process.exit(1);
}
console.log(`✔ ${passed}/${passed} checks PASSED`);
process.exit(0);

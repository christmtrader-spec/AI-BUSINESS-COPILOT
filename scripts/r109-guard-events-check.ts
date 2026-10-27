/**
 * R109 — platform guard-events ops-visibility CHECKS.
 *
 * A. PARSER unit proofs on a TEMP fixture log (GUARD_LOG_PATH override —
 *    the REAL guard log is never written by tests):
 *      - every known line shape maps to its kind (recycle start/done,
 *        spawn ok/failed + why, high-rss + streak, recovered, guard-start,
 *        refusal), extracting rssMb/pid/streak/spawnWhy;
 *      - newest-first ordering, limit clamping, partial/unknown lines skipped;
 *      - missing file → available:false (honest absence, never invented);
 *      - a >64KB log sets truncated:true and still parses the tail.
 * B. API gates against the LIVE route:
 *      - anonymous → 401; tenant session → 403 (platform:system:read law);
 *      - PLATFORM_READONLY operator → 200 with the honest shape (available,
 *        scope:"dev-server", bounded events, every event at/kind/message);
 *      - ?limit=5 returns ≤5 events.
 * C. Cleanup: FK-safe removal of the fixture users/operator rows + census.
 *
 * Run:  bun --conditions react-server scripts/r109-guard-events-check.ts
 * Exit: 0 = all green, 1 = any check failed.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { PrismaClient } from "@prisma/client";
import { parseGuardLine, readGuardEvents } from "../src/lib/observability/guard-events";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const TS = Date.now().toString(36);
const PW = "R109Ops!x2026";
const OPERATOR_EMAIL = `r109-ops-${TS}@t.dev`;
const TENANT_EMAIL = `r109-tenant-${TS}@t.dev`;

type Check = { name: string; ok: boolean; info?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, info?: string) {
  checks.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? ` — ${info}` : ""}`);
}

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.109.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const raw = res.headers.get("set-cookie");
    if (raw) {
      for (const piece of raw.split(/,(?=[^;]+=)/)) {
        const [pair] = piece.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return res;
  };
}
function callerOf(jar: Map<string, string>) {
  const f = jarFetch(jar);
  return async (path: string, init: RequestInit = {}) => {
    const res = await f(path, init);
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
}
async function login(email: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = jarFetch(jar);
  const csrf = await f("/api/auth/csrf");
  // Response.json is a METHOD — csrf.json?.csrfToken was always undefined,
  // which silently sent "csrfToken=undefined" and CSRF-rejected the callback.
  const csrfData = (await csrf.json()) as { csrfToken: string };
  const body = new URLSearchParams({ csrfToken: csrfData.csrfToken, email, password: PW });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  // R109 lesson: next-auth answers 302 BOTH on success and on FAILED
  // credentials (redirect to the error page) — Location must be checked too,
  // otherwise a broken fixture looks "logged in" and every later call 401s
  // for a confusing reason.
  const loc = res.headers.get("location") ?? "";
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed: ${res.status}`);
  if (loc.includes("error=")) throw new Error(`login rejected for ${email}: ${loc.slice(0, 120)}`);
  if (!jar.has("next-auth.session-token")) throw new Error(`no session cookie for ${email}`);
  return jar;
}

/* --------------------------- A. parser proofs ----------------------------- */

async function parserProofs() {
  console.log("== A. parser unit proofs (temp fixture log) ==");
  const dir = mkdtempSync(join(tmpdir(), "r109-guard-"));
  const logPath = join(dir, "guard.log");
  process.env.GUARD_LOG_PATH = logPath;

  const lines = [
    "[2026-10-25T01:00:00.000Z] guard started pid=111 (water=2450MB, consecutive=3, interval=30s)",
    "[2026-10-25T01:05:00.000Z] high rss: 2501MB (streak 1/3) pid=122",
    "[2026-10-25T01:05:30.000Z] high rss: 2610MB (streak 2/3) pid=122",
    "[2026-10-25T01:06:00.000Z] rss recovered: 2100MB (streak reset)",
    "[2026-10-25T01:10:00.000Z] RECYCLE start: next-server pid=122 rss=2680MB sustained ≥3 samples over 2450MB",
    "[2026-10-25T01:10:13.000Z] spawn(recycle) attempt=1 pid=133 — waiting for health 200",
    "[2026-10-25T01:10:14.000Z] spawn(recycle) OK after ~13s pid=133",
    "[2026-10-25T01:10:14.001Z] RECYCLE done: old rss=2680MB reclaimed",
    "[2026-10-25T01:12:00.000Z] :3000 is already serving — refusing to start a duplicate `next dev`",
    "not-a-guard-line",
    "",
  ];
  // Newest line goes LAST in the file; newest-first is asserted after parse.
  writeFileSync(logPath, lines.join("\n") + "\n");

  const r = await readGuardEvents(30);
  check("A1 available=true for an existing log", r.available === true);
  check("A2 newest-first ordering", r.events[0]?.message.includes("refusing") === true && r.events[r.events.length - 1]?.kind === "guard-start");
  check("A3 partial/unknown lines skipped (9 events from 9 real lines)", r.events.length === 9, `got ${r.events.length}`);

  const byKind = (k: string) => r.events.filter((e) => e.kind === k);
  check("A4 guard-start extracts pid", byKind("guard-start")[0]?.pid === 111);
  // Newest-first: [0] is the LATER high-rss line; [-1] (oldest) carries 2501/1-3.
  check("A5 high-rss extracts rss+streak+pid", (() => { const e = byKind("high-rss").at(-1); return e?.rssMb === 2501 && e?.streak === "1/3" && e?.pid === 122; })());
  check("A6 recovered extracts rss", byKind("recovered")[0]?.rssMb === 2100);
  check("A7 recycle-start extracts rss+pid", (() => { const e = byKind("recycle-start")[0]; return e?.rssMb === 2680 && e?.pid === 122; })());
  check("A8 spawn attempt line stays raw 'other'", byKind("other").length === 1);
  check("A9 spawn-ok extracts pid + why=recycle", (() => { const e = byKind("spawn-ok")[0]; return e?.pid === 133 && e?.spawnWhy === "recycle"; })());
  check("A10 recycle-done extracts old rss", byKind("recycle-done")[0]?.rssMb === 2680);
  check("A11 duplicate/refusal line → refusal kind", byKind("refusal").length === 1);
  check("A12 summary counts match window", (r.summary.counts["high-rss"] ?? 0) === 2 && (r.summary.counts["recycle-start"] ?? 0) === 1);

  const lim = await readGuardEvents(5);
  check("A13 limit clamps the returned window", lim.events.length === 5);

  // spawn-failed shape (GAVE UP)
  writeFileSync(logPath, "[2026-10-25T02:00:00.000Z] spawn(down) GAVE UP after 2 attempts — keep-dev-up/ensure-dev must take over\n");
  const r2 = await readGuardEvents(10);
  check("A14 spawn GAVE UP → spawn-failed with why=down", r2.events[0]?.kind === "spawn-failed" && r2.events[0]?.spawnWhy === "down");

  // >64KB log → truncated flag, tail still parsed
  const filler = Array.from({ length: 1200 }, (_, i) => `[2026-10-25T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z] high rss: ${1000 + i}MB (streak 1/3) pid=9`);
  const tailLine = "[2026-10-25T03:00:00.000Z] RECYCLE done: old rss=9999MB reclaimed";
  writeFileSync(logPath, [...filler, tailLine].join("\n") + "\n");
  const r3 = await readGuardEvents(30);
  check("A15 >64KB log → truncated=true", r3.truncated === true);
  check("A16 tail still parsed (newest = RECYCLE done)", r3.events[0]?.kind === "recycle-done" && r3.events[0]?.rssMb === 9999);

  // missing file → honest absence
  process.env.GUARD_LOG_PATH = join(dir, "does-not-exist.log");
  const r4 = await readGuardEvents(10);
  check("A17 missing log → available:false, zero events (never invented)", r4.available === false && r4.events.length === 0 && r4.summary.lastEventAt === null);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.GUARD_LOG_PATH;
}

/* ----------------------------- B. API gates -------------------------------- */

async function apiGates() {
  console.log("== B. live API gates ==");
  const anon = await callerOf(new Map())("/api/v1/platform/system/guard-events");
  check("B1 anonymous → 401", anon.status === 401, `status=${anon.status}`);

  const hash = require("bcryptjs").hashSync(PW, 10);
  const tenant = await db.user.create({ data: { email: TENANT_EMAIL, name: "R109 Tenant", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opUser = await db.user.create({ data: { email: OPERATOR_EMAIL, name: "R109 Readonly Op", passwordHash: hash, emailVerifiedAt: new Date() } });
  await db.platformOperator.create({ data: { userId: opUser.id, role: "PLATFORM_READONLY", active: true } });

  const T = callerOf(await login(TENANT_EMAIL));
  const tRes = await T("/api/v1/platform/system/guard-events");
  check("B2 tenant session → 403 (system:read law)", tRes.status === 403, `status=${tRes.status} code=${tRes.json?.error?.code}`);

  const O = callerOf(await login(OPERATOR_EMAIL));
  const oRes = await O("/api/v1/platform/system/guard-events");
  const data = oRes.json?.data;
  check("B3 READONLY operator → 200", oRes.status === 200, `status=${oRes.status}`);
  check(
    "B4 honest shape: scope=dev-server, bounded events, well-formed rows",
    data?.scope === "dev-server" &&
      typeof data?.available === "boolean" &&
      Array.isArray(data?.events) &&
      data.events.length <= 30 &&
      data.events.every((e: any) => typeof e.at === "string" && typeof e.kind === "string" && typeof e.message === "string"),
    `available=${data?.available} events=${data?.events?.length}`,
  );
  check(
    "B5 REAL guard log readable in sandbox (dev infra exists)",
    data?.available === true && (data?.events?.length ?? 0) > 0,
    `last=${data?.summary?.lastEventAt}`,
  );

  const limRes = await O("/api/v1/platform/system/guard-events?limit=5");
  check("B6 ?limit=5 → ≤5 events", limRes.status === 200 && (limRes.json?.data?.events?.length ?? 99) <= 5, `n=${limRes.json?.data?.events?.length}`);
  const bigRes = await O("/api/v1/platform/system/guard-events?limit=9999&bogus=1");
  check("B7 limit=9999 clamped server-side (≤100)", bigRes.status === 200 && (bigRes.json?.data?.events?.length ?? 99) <= 100);

  // Non-operator route never leaks data through the tenant's own business API
  const tenantMe = await T("/api/v1/me");
  check("B8 tenant /me unaffected (isolation)", tenantMe.status === 200 && typeof tenantMe.json?.data?.id === "string", `status=${tenantMe.status}`);

  return { tenantId: tenant.id, opUserId: opUser.id };
}

/* ------------------------------- C. cleanup -------------------------------- */

async function cleanup(ids: { tenantId: string; opUserId: string }) {
  console.log("== C. cleanup ==");
  await db.platformOperator.deleteMany({ where: { userId: ids.opUserId } });
  await db.user.deleteMany({ where: { id: { in: [ids.tenantId, ids.opUserId] } } });
  // r109 fixtures match the sweep utility's %@t.dev pattern; the same sweep
  // also collects the smoke-suite's known leaks (smkowner*/inv*) so the
  // census returns to the canonical 5/3 after every battery run.
  // R111 hardening: the sweep exits early with "nothing to sweep." when the
  // direct deletes already restored the baseline — tolerate BOTH success
  // shapes and prove the census from the DB itself (never from its output).
  const { execFileSync } = await import("node:child_process");
  let out = "";
  try {
    out = execFileSync("bun", ["scripts/r104-user-sweep.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = `${((e as { stdout?: string })?.stdout ?? "")}${((e as { stderr?: string })?.stderr ?? "")}`;
  }
  const fk = await db.$queryRawUnsafe<{ n: number }[]>(`PRAGMA foreign_key_check`);
  const census = await db.$queryRawUnsafe<{ users: number; biz: number }[]>(
    `SELECT (SELECT COUNT(*) FROM "User") AS users, (SELECT COUNT(*) FROM "Business") AS biz`,
  );
  check(
    "C1 fk clean + zero residue after sweep",
    fk.length === 0 && (out.includes("residue: 0") || out.includes("nothing to sweep")),
    out.trim().split("\n").pop(),
  );
  check(
    "C2 census baseline 5/3",
    Number(census[0]?.users) === 5 && Number(census[0]?.biz) === 3,
    `users=${census[0]?.users} businesses=${census[0]?.biz}`,
  );
}

async function main() {
  await parserProofs();
  let ids: { tenantId: string; opUserId: string } | null = null;
  try {
    ids = await apiGates();
  } finally {
    if (ids) await cleanup(ids);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr109 guard-events checks: ${checks.length - failed.length}/${checks.length} passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

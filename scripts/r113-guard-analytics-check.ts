/**
 * R113 — guard OPS ANALYTICS checks (memory story + spawn grouping).
 *
 * The reader's summary now carries the memory story — peakRssMb, lastRecycle,
 * avgReclaimedMb and spawnBreakdown (recycle vs self-heal spawns) — and the
 * GuardCard's "Self-heals" chip is FIXED: it used to compare
 * spawnWhy === "down" while the daemon's REAL token is "down-selfheal", so
 * the chip read 0 forever while real self-heals happened. The canonical
 * grouping lives in src/lib/observability/guard-groups.ts (pure, client-safe).
 *
 * A. UNIT proofs on TEMP fixtures (GUARD_LOG_PATH + GUARD_EVENTS_JSONL_PATH
 *    overrides — the REAL guard files are never written by tests):
 *      - spawnGroupOf: the daemon's real "down-selfheal" → selfheal; the
 *        legacy fixture token "down" → selfheal; "recycle" → recycle;
 *        undefined → undefined; future unknown tokens → other (visible,
 *        never crashing);
 *      - analytics over a merged text+mirror fixture: peak = max rssMb,
 *        avgReclaimed = mean of recycle-done old-RSS, lastRecycle = newest
 *        recycle-done, spawnBreakdown counts grouped spawn-oks (mirror rows
 *        included);
 *      - honesty: a window with no recycle-done → lastRecycle null +
 *        avgReclaimedMb null; no rss-bearing events → peakRssMb null; no
 *        sinks at all → stable empty shape (spawnBreakdown {0,0}, nulls).
 * B. LIVE gates (real files, real route, REAL daemon tokens):
 *      - anonymous → 401; tenant session → 403; READONLY operator → 200;
 *      - summary.spawnBreakdown is CONSISTENT with the returned events
 *        (recomputed client-side through spawnGroupOf — equality proven on
 *        whatever the live window holds, so the R109 chip bug can never
 *        silently return);
 *      - peakRssMb = max rssMb among returned events; recycle aggregates
 *        match the window's recycle-done rows; limit clamp respected.
 * C. Cleanup: FK-safe sweep + census baseline.
 *
 * Run:  bun --conditions react-server scripts/r113-guard-analytics-check.ts
 * Exit: 0 = all green, 1 = any check failed.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { PrismaClient } from "@prisma/client";
import { readGuardEvents } from "../src/lib/observability/guard-events";
import { spawnGroupOf } from "../src/lib/observability/guard-groups";
import { loginCredentials } from "./lib/platform-mfa";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const TS = Date.now().toString(36);
const PW = "R113Ops!2026";
const OPERATOR_EMAIL = `r113-ops-${TS}@t.dev`;
const TENANT_EMAIL = `r113-tenant-${TS}@t.dev`;

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
      "x-forwarded-for": `10.113.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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
  return loginCredentials(f, jar, email, PW);
}

/* --------------------- A. grouping + analytics proofs --------------------- */

async function analyticsProofs() {
  console.log("== A. spawnGroupOf + memory-story proofs (temp fixtures) ==");

  // A1-A5 — the canonical grouping (THE R109 bug's fix, pinned forever)
  check("A1 daemon's REAL token 'down-selfheal' → selfheal", spawnGroupOf("down-selfheal") === "selfheal");
  check("A2 legacy fixture token 'down' → selfheal (old tests keep passing)", spawnGroupOf("down") === "selfheal");
  check("A3 'recycle' → recycle", spawnGroupOf("recycle") === "recycle");
  check("A4 undefined → undefined (non-spawn events)", spawnGroupOf(undefined) === undefined);
  check("A5 future unknown token → other (visible, never crashes)", spawnGroupOf("rollback") === "other");

  const dir = mkdtempSync(join(tmpdir(), "r113-analytics-"));
  const logPath = join(dir, "guard.log");
  const mirrorPath = join(dir, "guard.events.jsonl");
  process.env.GUARD_LOG_PATH = logPath;
  process.env.GUARD_EVENTS_JSONL_PATH = mirrorPath;

  // A rich window: two recycles, one REAL-token self-heal spawn (text log),
  // one mirrored self-heal spawn, rss peaks across kinds.
  writeFileSync(
    logPath,
    [
      "[2026-10-25T04:00:00.000Z] guard started pid=60 (water=2450MB, consecutive=3, interval=30s)",
      "[2026-10-25T04:05:00.000Z] high rss: 2500MB (streak 1/3) pid=61",
      "[2026-10-25T04:06:00.000Z] high rss: 2600MB (streak 2/3) pid=61",
      "[2026-10-25T04:07:00.000Z] RECYCLE start: next-server pid=61 rss=2600MB sustained ≥3 samples over 2450MB",
      "[2026-10-25T04:07:30.000Z] spawn(recycle) OK after ~5s pid=62",
      "[2026-10-25T04:07:31.000Z] RECYCLE done: old rss=2600MB reclaimed",
      "[2026-10-25T04:10:00.000Z] spawn(down-selfheal) OK after ~9s pid=63",
      "[2026-10-25T04:12:00.000Z] high rss: 2700MB (streak 1/3) pid=62",
      "[2026-10-25T04:13:00.000Z] RECYCLE done: old rss=2500MB reclaimed",
    ].join("\n") + "\n",
  );
  // One mirrored self-heal spawn (real daemon shape) + one mirrored high-rss.
  writeFileSync(
    mirrorPath,
    [
      JSON.stringify({ ts: "2026-10-25T04:14:00.000Z", kind: "spawn-ok", msg: "spawn(down-selfheal) OK after ~2s pid=64", spawnWhy: "down-selfheal", pid: 64 }),
      JSON.stringify({ ts: "2026-10-25T04:14:30.000Z", kind: "high-rss", msg: "high rss: 2455MB (streak 1/3) pid=64", rssMb: 2455, streak: "1/3", pid: 64, waterMb: 2450 }),
    ].join("\n") + "\n",
  );

  const r = await readGuardEvents(30);
  check("A6 both sinks merged", r.available === true && r.mirror.available === true && r.events.length === 11, `events=${r.events.length}`);
  check("A7 peakRssMb = max rss across ALL kinds (2700, not the mirror's 2455)", r.summary.peakRssMb === 2700, `got ${r.summary.peakRssMb}`);
  check("A8 avgReclaimedMb = mean of recycle-done old-RSS ((2600+2500)/2 = 2550)", r.summary.avgReclaimedMb === 2550, `got ${r.summary.avgReclaimedMb}`);
  check(
    "A9 lastRecycle = NEWEST recycle-done with its own oldRssMb",
    r.summary.lastRecycle?.at === "2026-10-25T04:13:00.000Z" && r.summary.lastRecycle?.oldRssMb === 2500,
    JSON.stringify(r.summary.lastRecycle),
  );
  check(
    "A10 spawnBreakdown: 1 recycle + 2 self-heal (text 'down-selfheal' + mirror row)",
    r.summary.spawnBreakdown.recycle === 1 && r.summary.spawnBreakdown.selfheal === 2,
    JSON.stringify(r.summary.spawnBreakdown),
  );
  const limited = await readGuardEvents(2);
  check(
    "A11 aggregates computed over the EXACT returned window (limit=2 = 2 newest only)",
    limited.events.length === 2 &&
      limited.summary.spawnBreakdown.selfheal === 1 &&
      limited.summary.spawnBreakdown.recycle === 0 &&
      limited.summary.lastRecycle === null &&
      limited.summary.avgReclaimedMb === null &&
      limited.summary.peakRssMb === 2455,
    `events=${limited.events.length} selfheal=${limited.summary.spawnBreakdown.selfheal} lastRecycle=${JSON.stringify(limited.summary.lastRecycle)} peak=${limited.summary.peakRssMb}`,
  );

  // Honesty: a window with NEITHER rss figures NOR recycle completions.
  const dir2 = mkdtempSync(join(tmpdir(), "r113-empty-"));
  process.env.GUARD_LOG_PATH = join(dir2, "guard.log");
  process.env.GUARD_EVENTS_JSONL_PATH = join(dir2, "guard.events.jsonl");
  writeFileSync(
    join(dir2, "guard.log"),
    ["[2026-10-25T04:20:00.000Z] guard started pid=70 (water=2450MB, consecutive=3, interval=30s)"].join("\n") + "\n",
  );
  const r2 = await readGuardEvents(30);
  check(
    "A12 honest nulls: no rss → peakRssMb null; no recycle-done → lastRecycle + avgReclaimedMb null",
    r2.summary.peakRssMb === null && r2.summary.lastRecycle === null && r2.summary.avgReclaimedMb === null,
    JSON.stringify(r2.summary),
  );
  check("A13 spawnBreakdown shape stable at zero", r2.summary.spawnBreakdown.recycle === 0 && r2.summary.spawnBreakdown.selfheal === 0);

  // Honesty: both sinks missing entirely (the pre-R109 empty shape, extended).
  const dir3 = mkdtempSync(join(tmpdir(), "r113-none-"));
  process.env.GUARD_LOG_PATH = join(dir3, "missing.log");
  process.env.GUARD_EVENTS_JSONL_PATH = join(dir3, "missing.events.jsonl");
  const r3 = await readGuardEvents(30);
  check(
    "A14 no sinks → available:false with the FULL stable summary shape",
    r3.available === false &&
      r3.summary.peakRssMb === null &&
      r3.summary.lastRecycle === null &&
      r3.summary.avgReclaimedMb === null &&
      r3.summary.spawnBreakdown.recycle === 0 &&
      r3.summary.spawnBreakdown.selfheal === 0,
  );

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
  rmSync(dir3, { recursive: true, force: true });
  delete process.env.GUARD_LOG_PATH;
  delete process.env.GUARD_EVENTS_JSONL_PATH;
}

/* ----------------------------- B. API gates ------------------------------- */

async function apiGates() {
  console.log("== B. live API gates ==");
  const anon = await callerOf(new Map())("/api/v1/platform/system/guard-events");
  check("B1 anonymous → 401", anon.status === 401, `status=${anon.status}`);

  const hash = require("bcryptjs").hashSync(PW, 10);
  const tenant = await db.user.create({ data: { email: TENANT_EMAIL, name: "R113 Tenant", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opUser = await db.user.create({ data: { email: OPERATOR_EMAIL, name: "R113 Readonly Op", passwordHash: hash, emailVerifiedAt: new Date() } });
  await db.platformOperator.create({ data: { userId: opUser.id, role: "PLATFORM_READONLY", active: true } });

  const T = callerOf(await login(TENANT_EMAIL));
  const tRes = await T("/api/v1/platform/system/guard-events");
  check("B2 tenant session → 403 (system:read law)", tRes.status === 403, `status=${tRes.status} code=${tRes.json?.error?.code}`);

  const O = callerOf(await login(OPERATOR_EMAIL));
  const oRes = await O("/api/v1/platform/system/guard-events");
  const data = oRes.json?.data;
  check("B3 READONLY operator → 200", oRes.status === 200, `status=${oRes.status}`);
  check(
    "B4 summary carries the R113 story with well-formed types",
    typeof data?.summary?.peakRssMb === "number" &&
      (data?.summary?.lastRecycle === null ||
        (typeof data.summary.lastRecycle?.at === "string" && typeof data.summary.lastRecycle?.oldRssMb === "number")) &&
      (data?.summary?.avgReclaimedMb === null || typeof data.summary.avgReclaimedMb === "number") &&
      typeof data?.summary?.spawnBreakdown?.recycle === "number" &&
      typeof data?.summary?.spawnBreakdown?.selfheal === "number",
    JSON.stringify(data?.summary),
  );

  // THE R109-bug regression proof, live: the summary's spawn grouping must
  // equal a client-side regroup of the SAME events through spawnGroupOf —
  // whatever the window holds. If the reader and the UI ever diverge again,
  // this equality fails.
  const evs: any[] = data?.events ?? [];
  const expectRecycle = evs.filter((e) => e.kind === "spawn-ok" && spawnGroupOf(e.spawnWhy) === "recycle").length;
  const expectSelfheal = evs.filter((e) => e.kind === "spawn-ok" && spawnGroupOf(e.spawnWhy) === "selfheal").length;
  check(
    "B5 live spawnBreakdown == client-side regroup of the same events",
    data?.summary?.spawnBreakdown?.recycle === expectRecycle && data?.summary?.spawnBreakdown?.selfheal === expectSelfheal,
    `summary=${JSON.stringify(data?.summary?.spawnBreakdown)} recomputed=${expectRecycle}/${expectSelfheal}`,
  );
  const liveRss = evs.map((e) => e.rssMb).filter((n): n is number => typeof n === "number");
  const expectPeak = liveRss.length ? Math.max(...liveRss) : null;
  check("B6 live peakRssMb == max rss among returned events", data?.summary?.peakRssMb === expectPeak, `summary=${data?.summary?.peakRssMb} recomputed=${expectPeak}`);
  const doneMbs = evs.filter((e) => e.kind === "recycle-done" && typeof e.rssMb === "number").map((e) => e.rssMb as number);
  const expectAvg = doneMbs.length ? Math.round(doneMbs.reduce((a: number, b: number) => a + b, 0) / doneMbs.length) : null;
  check(
    "B7 live avg/last recycle aggregates == window's recycle-done rows",
    data?.summary?.avgReclaimedMb === expectAvg &&
      (expectAvg === null ||
        (data.summary.lastRecycle?.oldRssMb !== undefined &&
          evs.some((e) => e.kind === "recycle-done" && e.at === data.summary.lastRecycle.at))),
    `avg=${data?.summary?.avgReclaimedMb} recomputed=${expectAvg}`,
  );
  check(
    "B8 the live window exercises the FIX (real daemon tokens present: selfheal ≥ 1)",
    expectSelfheal >= 1,
    `selfheal=${expectSelfheal} recycle=${expectRecycle} (the running guard's own down-selfheal spawns)`,
  );

  const limRes = await O("/api/v1/platform/system/guard-events?limit=5");
  check("B9 limit clamp still holds", limRes.status === 200 && (limRes.json?.data?.events?.length ?? 99) <= 5, `events=${limRes.json?.data?.events?.length}`);

  const tenantMe = await T("/api/v1/me");
  check("B10 tenant /me unaffected (isolation)", tenantMe.status === 200 && typeof tenantMe.json?.data?.id === "string", `status=${tenantMe.status}`);

  return { tenantId: tenant.id, opUserId: opUser.id };
}

/* ------------------------------- C. cleanup ------------------------------- */

async function cleanup(ids: { tenantId: string; opUserId: string }) {
  console.log("== C. cleanup ==");
  await db.platformOperator.deleteMany({ where: { userId: ids.opUserId } });
  await db.user.deleteMany({ where: { id: { in: [ids.tenantId, ids.opUserId] } } });
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
    "C1 fk clean + sweep clean (residue 0 or nothing to sweep)",
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
  await analyticsProofs();
  let ids: { tenantId: string; opUserId: string } | null = null;
  try {
    ids = await apiGates();
  } finally {
    if (ids) await cleanup(ids);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr113 guard-analytics checks: ${checks.length - failed.length}/${checks.length} passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

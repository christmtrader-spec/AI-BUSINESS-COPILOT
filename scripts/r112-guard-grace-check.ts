/**
 * R112 — guard GRACE window + operator-card depth CHECKS.
 *
 * A. UNIT proofs (pure policy lib + reader passthrough on TEMP fixtures):
 *      - effectiveWaterMb: sample 0 (fresh spawn) → base+headroom; boundary
 *        sample graceSamples-1 → still grace; sample graceSamples → base;
 *        boot (no spawn yet) → base; graceSamples=0 → disabled (base);
 *        defaults exported and applied.
 *      - parseMirrorLine preserves R112 fields (effWaterMb, graceActive) and
 *        readGuardEvents surfaces summary.generationStartedAt (newest
 *        spawn-ok in the merged window; null when none).
 * B. LIVE gates (real guard files, real route):
 *      - anonymous → 401; tenant → 403; READONLY operator → 200;
 *      - the LIVE mirrored guard-start row carries graceSamples=4 +
 *        graceHeadroomMb=300 (the running daemon runs the R112 policy);
 *      - summary.generationStartedAt populated (a spawn exists in window).
 * C. Cleanup: FK-safe sweep + census baseline (DB-proven).
 *
 * Run:  bun --conditions react-server scripts/r112-guard-grace-check.ts
 * Exit: 0 = all green, 1 = any check failed.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { parseMirrorLine, readGuardEvents } from "../src/lib/observability/guard-events";
import { loginCredentials } from "./lib/platform-mfa";

const require = createRequire(import.meta.url);
const { effectiveWaterMb, GRACE_SAMPLES_DEFAULT, GRACE_HEADROOM_MB_DEFAULT } = require("./lib/guard-policy.cjs");

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const TS = Date.now().toString(36);
const PW = "R112Grace!2026";
const OPERATOR_EMAIL = `r112-ops-${TS}@t.dev`;
const TENANT_EMAIL = `r112-tenant-${TS}@t.dev`;

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
      "x-forwarded-for": `10.112.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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

/* --------------------------- A. unit proofs ------------------------------- */

async function policyProofs() {
  console.log("== A. grace policy + reader passthrough proofs ==");

  const fresh = effectiveWaterMb({ baseWaterMb: 2450, samplesSinceSpawn: 0 });
  check("A1 sample 0 (fresh spawn) → grace water", fresh.inGrace === true && fresh.effWaterMb === 2450 + GRACE_HEADROOM_MB_DEFAULT, JSON.stringify(fresh));
  const last = effectiveWaterMb({ baseWaterMb: 2450, samplesSinceSpawn: GRACE_SAMPLES_DEFAULT - 1 });
  check("A2 boundary sample (graceSamples-1) → still grace", last.inGrace === true && last.effWaterMb === 2450 + GRACE_HEADROOM_MB_DEFAULT);
  const expired = effectiveWaterMb({ baseWaterMb: 2450, samplesSinceSpawn: GRACE_SAMPLES_DEFAULT });
  check("A3 sample graceSamples → back to base water", expired.inGrace === false && expired.effWaterMb === 2450);
  const boot = effectiveWaterMb({ baseWaterMb: 2450, samplesSinceSpawn: Number.MAX_SAFE_INTEGER });
  check("A4 boot (no spawn yet) → NO grace (strict base water)", boot.inGrace === false && boot.effWaterMb === 2450);
  const off = effectiveWaterMb({ baseWaterMb: 2450, samplesSinceSpawn: 0, graceSamples: 0 });
  check("A5 graceSamples=0 → disabled (base water)", off.inGrace === false && off.effWaterMb === 2450);
  const zeroHead = effectiveWaterMb({ baseWaterMb: 2450, samplesSinceSpawn: 0, graceHeadroomMb: 0 });
  check("A6 headroom=0 → no effective change", zeroHead.inGrace === false && zeroHead.effWaterMb === 2450);
  const custom = effectiveWaterMb({ baseWaterMb: 100, samplesSinceSpawn: 1, graceSamples: 2, graceHeadroomMb: 50 });
  check("A7 custom knobs honored", custom.inGrace === true && custom.effWaterMb === 150);
  check("A8 defaults exported (4 samples / 300MB)", GRACE_SAMPLES_DEFAULT === 4 && GRACE_HEADROOM_MB_DEFAULT === 300);
  const bad = effectiveWaterMb({ baseWaterMb: Number.NaN, samplesSinceSpawn: 0 });
  check("A9 NaN base never produces NaN water", Number.isFinite(bad.effWaterMb), JSON.stringify(bad));

  // reader passthrough on temp fixtures (never the real guard files)
  const dir = mkdtempSync(join(tmpdir(), "r112-grace-"));
  const logPath = join(dir, "guard.log");
  const mirrorPath = join(dir, "guard.events.jsonl");
  process.env.GUARD_LOG_PATH = logPath;
  process.env.GUARD_EVENTS_JSONL_PATH = mirrorPath;
  writeFileSync(logPath, "[2026-10-25T04:00:00.000Z] spawn(down-selfheal) OK after ~2s pid=70\n");
  writeFileSync(
    mirrorPath,
    [
      JSON.stringify({ ts: "2026-10-25T04:01:00.000Z", kind: "high-rss", msg: "high rss: 2600MB (streak 1/3) pid=71 [grace]", rssMb: 2600, streak: "1/3", pid: 71, waterMb: 2450, effWaterMb: 2750, graceActive: true }),
      JSON.stringify({ ts: "2026-10-25T04:00:00.000Z", kind: "spawn-ok", msg: "spawn(down-selfheal) OK after ~2s pid=70", spawnWhy: "down", pid: 70 }),
    ].join("\n") + "\n",
  );
  const r = await readGuardEvents(30);
  const graceRow = r.events.find((e) => e.kind === "high-rss");
  check("A10 effWaterMb + graceActive survive the mirror parse", graceRow?.effWaterMb === 2750 && graceRow?.graceActive === true, JSON.stringify(graceRow));
  check("A11 generationStartedAt = newest spawn-ok in window", r.summary.generationStartedAt === "2026-10-25T04:00:00.000Z", String(r.summary.generationStartedAt));
  rmSync(mirrorPath, { force: true });
  // Also drop the spawn from the TEXT log — otherwise the text sink still
  // knows the generation and "honest absence" can't be proven.
  writeFileSync(logPath, "[2026-10-25T04:02:00.000Z] rss recovered: 2100MB (streak reset)\n");
  const r2 = await readGuardEvents(30);
  check("A12 no spawn in any sink → generationStartedAt null (honest)", r2.summary.generationStartedAt === null);

  delete process.env.GUARD_LOG_PATH;
  delete process.env.GUARD_EVENTS_JSONL_PATH;
  rmSync(dir, { recursive: true, force: true });
}

/* ----------------------------- B. live gates ------------------------------ */

async function apiGates() {
  console.log("== B. live API gates (real guard files) ==");
  const anon = await callerOf(new Map())("/api/v1/platform/system/guard-events");
  check("B1 anonymous → 401", anon.status === 401, `status=${anon.status}`);

  const hash = require("bcryptjs").hashSync(PW, 10);
  const tenant = await db.user.create({ data: { email: TENANT_EMAIL, name: "R112 Tenant", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opUser = await db.user.create({ data: { email: OPERATOR_EMAIL, name: "R112 Readonly Op", passwordHash: hash, emailVerifiedAt: new Date() } });
  await db.platformOperator.create({ data: { userId: opUser.id, role: "PLATFORM_READONLY", active: true } });

  const tJar = new Map<string, string>();
  const T = callerOf(await loginCredentials(jarFetch(tJar), tJar, TENANT_EMAIL, PW));
  const tRes = await T("/api/v1/platform/system/guard-events");
  check("B2 tenant session → 403 (system:read law)", tRes.status === 403, `status=${tRes.status}`);

  const oJar = new Map<string, string>();
  const O = callerOf(await loginCredentials(jarFetch(oJar), oJar, OPERATOR_EMAIL, PW));
  const oRes = await O("/api/v1/platform/system/guard-events");
  const data = oRes.json?.data;
  check("B3 READONLY operator → 200", oRes.status === 200, `status=${oRes.status}`);
  // R113 hardening — the original B4 required the daemon's guard-start row
  // to still sit inside the 30-event window: a TIME BOMB. ~60 events later
  // the window slides past the birth and the check fails with NO app bug.
  // Robust proof at limit=100 (the clamp max): the NEWEST in-window
  // guard-start (the current daemon's birth) must carry the grace knobs;
  // if even the wide window has slid past it, fall back to the policy's
  // runtime fingerprints — post-R112 high-rss samples always carry
  // effWaterMb + graceActive. Either fingerprint failing = the running
  // daemon genuinely isn't running the R112 policy.
  const wideRes = await O("/api/v1/platform/system/guard-events?limit=100");
  const wideData = wideRes.json?.data;
  const wideStarts = (wideData?.events ?? []).filter((e: any) => e.kind === "guard-start");
  const newestStart = wideStarts[0];
  const wideHighRss = (wideData?.events ?? []).filter((e: any) => e.kind === "high-rss");
  const graceJudged = wideHighRss.filter((e: any) => typeof e.effWaterMb === "number" && typeof e.graceActive === "boolean");
  check(
    "B4 LIVE daemon runs the grace policy (guard-start knobs or grace-judged samples)",
    (newestStart ? newestStart.graceSamples === 4 && newestStart.graceHeadroomMb === 300 : graceJudged.length > 0),
    newestStart
      ? `guard-start ts=${newestStart.at} graceSamples=${newestStart.graceSamples} graceHeadroomMb=${newestStart.graceHeadroomMb}`
      : `no guard-start in wide window; grace-judged high-rss rows=${graceJudged.length}/${wideHighRss.length}`,
  );
  check(
    "B5 generationStartedAt populated (a spawn exists in the window)",
    typeof data?.summary?.generationStartedAt === "string" && !Number.isNaN(new Date(data.summary.generationStartedAt).getTime()),
    String(data?.summary?.generationStartedAt),
  );

  const tenantMe = await T("/api/v1/me");
  check("B6 tenant /me unaffected (isolation)", tenantMe.status === 200 && typeof tenantMe.json?.data?.id === "string", `status=${tenantMe.status}`);

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
    "C2 census baseline 7/5 (the 2026-10-30 third DB wipe recovered the September KEEP-baseline via git blob 766d32a; R136; supersedes the R134 5/3 env-repair floor)",
    Number(census[0]?.users) === 7 && Number(census[0]?.biz) === 5,
    `users=${census[0]?.users} businesses=${census[0]?.biz}`,
  );
}

async function main() {
  await policyProofs();
  let ids: { tenantId: string; opUserId: string } | null = null;
  try {
    ids = await apiGates();
  } finally {
    if (ids) await cleanup(ids);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr112 guard-grace checks: ${checks.length - failed.length}/${checks.length} passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

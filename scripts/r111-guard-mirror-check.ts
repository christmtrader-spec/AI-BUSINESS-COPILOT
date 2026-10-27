/**
 * R111 — guard-event JSONL MIRROR checks (events surviving the text log).
 *
 * The guard daemon now writes every event to BOTH sinks with ONE timestamp:
 * the human text log and a structured JSONL mirror ({ts, kind, msg, ...}).
 * The reader merges both tails; mirrored rows are authoritative and dedupe
 * against their text twins by `at|message`.
 *
 * A. UNIT proofs on TEMP fixtures (GUARD_LOG_PATH + GUARD_EVENTS_JSONL_PATH
 *    overrides — the REAL guard files are never written by tests):
 *      - parseMirrorLine: structured row → event with exact fields;
 *        malformed rows / wrong shapes / unknown kinds handled honestly;
 *      - dedupe: a mirrored event + its identical text twin = ONE event,
 *        with the mirror's structured fields winning;
 *      - mirror-only history: events present ONLY in the JSONL (text log
 *        rotated away) still surface — the whole point of the mirror;
 *      - mirror-off honesty: no JSONL file → mirror.available=false;
 *      - firstEventAt = oldest event in the returned window.
 * B. LIVE gates (real files, real route):
 *      - anonymous → 401; tenant session → 403; READONLY operator → 200;
 *      - the response carries mirrorPath + mirror.available=true because the
 *        restarted R111 guard has already mirrored its guard-start event;
 *      - summary.firstEventAt ≤ lastEventAt (history depth is populated).
 * C. Cleanup: FK-safe sweep + census baseline.
 *
 * Run:  bun --conditions react-server scripts/r111-guard-mirror-check.ts
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
import { parseMirrorLine, readGuardEvents } from "../src/lib/observability/guard-events";
import { loginCredentials } from "./lib/platform-mfa";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const TS = Date.now().toString(36);
const PW = "R111Mirror!2026";
const OPERATOR_EMAIL = `r111-ops-${TS}@t.dev`;
const TENANT_EMAIL = `r111-tenant-${TS}@t.dev`;

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
      "x-forwarded-for": `10.111.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
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

/* ------------------------ A. mirror unit proofs --------------------------- */

async function mirrorProofs() {
  console.log("== A. JSONL mirror unit proofs (temp fixtures) ==");
  const dir = mkdtempSync(join(tmpdir(), "r111-mirror-"));
  const logPath = join(dir, "guard.log");
  const mirrorPath = join(dir, "guard.events.jsonl");
  process.env.GUARD_LOG_PATH = logPath;
  process.env.GUARD_EVENTS_JSONL_PATH = mirrorPath;

  // parseMirrorLine row shapes
  const good = parseMirrorLine(
    JSON.stringify({ ts: "2026-10-25T03:30:00.000Z", kind: "recycle-start", msg: "RECYCLE start: next-server pid=9 rss=2500MB sustained ≥3 samples over 2450MB", rssMb: 2500, pid: 9, consecutive: 3, waterMb: 2450 }),
  );
  check("A1 mirrored row parses with exact structured fields", good?.kind === "recycle-start" && good?.rssMb === 2500 && good?.pid === 9 && good?.waterMb === 2450 && good?.at === "2026-10-25T03:30:00.000Z", JSON.stringify(good));
  check("A2 unknown kind falls through to 'other'", parseMirrorLine(JSON.stringify({ ts: "2026-10-25T03:30:01.000Z", kind: "mystery", msg: "?" }))?.kind === "other");
  check("A3 torn/partial JSON row skipped (never throws)", parseMirrorLine('{"ts":"2026-10-25T03:30:02.00') === null);
  check("A4 row without ts rejected", parseMirrorLine(JSON.stringify({ kind: "high-rss", msg: "x" })) === null);
  check("A5 row without kind rejected", parseMirrorLine(JSON.stringify({ ts: "2026-10-25T03:30:03.000Z", msg: "x" })) === null);
  check("A6 non-numeric rssMb ignored (no coercion crash)", (() => { const e = parseMirrorLine(JSON.stringify({ ts: "2026-10-25T03:30:04.000Z", kind: "high-rss", msg: "x", rssMb: "wide" })); return e?.kind === "high-rss" && e?.rssMb === undefined; })());
  check("A7 blank line skipped", parseMirrorLine("   ") === null);

  // merge + dedupe: mirror wins, text fills gaps, mirror-only survives
  const textLines = [
    "[2026-10-25T03:00:00.000Z] guard started pid=50 (water=2450MB, consecutive=3, interval=30s)",
    "[2026-10-25T03:05:00.000Z] high rss: 2501MB (streak 1/3) pid=51",
    "[2026-10-25T03:06:00.000Z] rss recovered: 2100MB (streak reset)",
  ];
  writeFileSync(logPath, textLines.join("\n") + "\n");
  // The 03:05 event is mirrored (with exact fields); the 03:00/03:06 lines
  // are pre-mirror history (text-only); 02:50 exists ONLY in the mirror —
  // its text twin rotated away, which is exactly what the mirror protects.
  writeFileSync(
    mirrorPath,
    [
      JSON.stringify({ ts: "2026-10-25T02:50:00.000Z", kind: "recycle-done", msg: "RECYCLE done: old rss=2700MB reclaimed", rssMb: 2700 }),
      JSON.stringify({ ts: "2026-10-25T03:05:00.000Z", kind: "high-rss", msg: "high rss: 2501MB (streak 1/3) pid=51", rssMb: 2501, streak: "1/3", pid: 51, waterMb: 2450 }),
      "not-json-at-all",
    ].join("\n") + "\n",
  );

  const r = await readGuardEvents(30);
  check("A8 available=true with both sinks", r.available === true);
  check("A9 mirror reported available with 2 parsed rows", r.mirror.available === true && r.mirror.merged === 2, JSON.stringify(r.mirror));
  check("A10 merged newest-first across sinks", r.events[0]?.at === "2026-10-25T03:06:00.000Z" && r.events[r.events.length - 1]?.at === "2026-10-25T02:50:00.000Z", r.events.map((e) => e.at).join(" | "));
  check("A11 dedupe: mirrored twin collapsed exactly once (4 unique = 3 text + 2 mirror − 1 twin)", r.events.length === 4 && r.events.filter((e) => e.at === "2026-10-25T03:05:00.000Z").length === 1, `got ${r.events.length}`);
  check("A12 mirror fields WIN over the text parse", r.events.find((e) => e.at === "2026-10-25T03:05:00.000Z")?.waterMb === 2450);
  check("A13 mirror-only event survives text rotation", r.events.some((e) => e.at === "2026-10-25T02:50:00.000Z" && e.kind === "recycle-done" && e.rssMb === 2700));
  check("A14 text-only history still parsed", r.events.some((e) => e.at === "2026-10-25T03:00:00.000Z" && e.kind === "guard-start" && e.pid === 50));
  check("A15 firstEventAt = oldest in window", r.summary.firstEventAt === "2026-10-25T02:50:00.000Z");
  check("A16 lastEventAt = newest in window", r.summary.lastEventAt === "2026-10-25T03:06:00.000Z");

  const lim = await readGuardEvents(2);
  check("A17 limit clamps the MERGED window (firstEventAt follows)", lim.events.length === 2 && lim.summary.firstEventAt === "2026-10-25T03:05:00.000Z");

  // mirror-off honesty: only the text log exists (pre-R111 world)
  rmSync(mirrorPath, { force: true });
  const r2 = await readGuardEvents(30);
  check("A18 no mirror file → mirror.available=false, text still served", r2.mirror.available === false && r2.mirror.merged === 0 && r2.available === true && r2.events.length === 3);

  // neither sink exists → honest absence (available:false)
  process.env.GUARD_LOG_PATH = join(dir, "nope.log");
  rmSync(mirrorPath, { force: true });
  const r3 = await readGuardEvents(10);
  check("A19 both sinks missing → available:false (never invented)", r3.available === false && r3.events.length === 0 && r3.mirror.available === false && r3.summary.firstEventAt === null);

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
  const tenant = await db.user.create({ data: { email: TENANT_EMAIL, name: "R111 Tenant", passwordHash: hash, emailVerifiedAt: new Date() } });
  const opUser = await db.user.create({ data: { email: OPERATOR_EMAIL, name: "R111 Readonly Op", passwordHash: hash, emailVerifiedAt: new Date() } });
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
  check(
    "B4 response carries mirrorPath + mirror state",
    typeof data?.mirrorPath === "string" && data.mirrorPath.endsWith(".jsonl") && typeof data?.mirror?.available === "boolean" && typeof data?.mirror?.merged === "number",
    `mirror=${JSON.stringify(data?.mirror)}`,
  );
  // R113 hardening — the original B5 asserted a guard-start row inside the
  // 30-event window: a TIME BOMB. Hours after the daemon's birth the window
  // slides past it and the check fails honestly (no app bug). Robust proof:
  // (a) mirror.available with merged>0 — the running daemon mirrors rows;
  // (b) in a WIDE window (limit=100), the NEWEST guard-start (the current
  //     daemon's birth, always post-R111 hence mirrored) must carry the
  //     structured waterMb — absent only if the daemon stopped mirroring,
  //     the exact regression this check exists to catch.
  const wideRes = await O("/api/v1/platform/system/guard-events?limit=100");
  const wideData = wideRes.json?.data;
  const wideStarts = (wideData?.events ?? []).filter((e: any) => e.kind === "guard-start");
  check(
    "B5 mirror LIVE (merged>0) + newest in-window guard-start is mirrored (structured waterMb)",
    data?.mirror?.available === true &&
      (data?.mirror?.merged ?? 0) > 0 &&
      (wideStarts.length === 0 || typeof wideStarts[0]?.waterMb === "number"),
    `merged=${data?.mirror?.merged} wideGuardStarts=${wideStarts.length} newestWaterMb=${wideStarts[0]?.waterMb}`,
  );
  check(
    "B6 history depth populated: firstEventAt ≤ lastEventAt",
    typeof data?.summary?.firstEventAt === "string" && typeof data?.summary?.lastEventAt === "string" && data.summary.firstEventAt.localeCompare(data.summary.lastEventAt) <= 0,
    `${data?.summary?.firstEventAt} → ${data?.summary?.lastEventAt}`,
  );

  const tenantMe = await T("/api/v1/me");
  check("B7 tenant /me unaffected (isolation)", tenantMe.status === 200 && typeof tenantMe.json?.data?.id === "string", `status=${tenantMe.status}`);

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
  // The sweep exits early with "nothing to sweep." when the direct deletes
  // already restored the baseline — tolerate BOTH success shapes and prove
  // the census from the DB itself (never from the sweep's output).
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
  await mirrorProofs();
  let ids: { tenantId: string; opUserId: string } | null = null;
  try {
    ids = await apiGates();
  } finally {
    if (ids) await cleanup(ids);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr111 guard-mirror checks: ${checks.length - failed.length}/${checks.length} passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

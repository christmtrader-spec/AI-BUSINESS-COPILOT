/**
 * r180-memory-ceiling-check.ts — the OOM-band hardening law.
 *
 * R180 (R179 §3 priority #2): the kernel OOM killer shot next-server at
 * ~1.7-2.2GB anon-rss during compile storms (R178 ×2, R179 ×1) — BELOW the
 * guard's 2600MB recycle water, so the external chain could only RECOVER
 * (~2s), never PREVENT. The honest lever the installed Next actually ships:
 * `experimental.turbopackMemoryLimit` — a soft engine ceiling that makes
 * Turbopack drop caches and collect BEFORE the external layers act.
 *
 * Sections:
 *  [1] the one-source law (scripts/dev-memory-ceiling.ts: the value, the
 *      MB->bytes unit law with its loud floor, the env knob contract)
 *  [2] the wiring law (next.config.ts passes the ceiling into
 *      experimental.turbopackMemoryLimit — no second arithmetic site)
 *  [3] the installed-next law (the key EXISTS in THIS next's config schema
 *      and BOTH consumption sites — dev hot-reloader + turbopack build —
 *      reference it; a Next upgrade that drops/renames the key turns this
 *      suite RED before the runtime goes silently unlimited)
 *  [4] the unit law (live: default bytes, env override conversion, the
 *      256MB floor throwing on a unit bug, the KB/MB typo class fenced)
 *  [5] the guard's near-band law (R180 layer 2 tripwire: the EARLY_WATER
 *      data-generator — rising edge, re-arm, NO recycle — and the standing
 *      recycle law 2600×3 byte-pinned untouched)
 *  [6] the census + registration law
 *
 * Run: npx tsx scripts/r180-memory-ceiling-check.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { familyCensus, assertRegistered } from "./family-census";
import {
  DEFAULT_TURBOPACK_MEMORY_MB,
  MIN_TURBOPACK_MEMORY_MB,
  TURBOPACK_MEMORY_ENV,
  turbopackMemoryCeilingBytes,
} from "./dev-memory-ceiling";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8");

const passed: string[] = [];
const failures: string[] = [];
function ok(name: string, cond: boolean, info?: string) {
  if (cond) passed.push(name);
  else failures.push(info ? `${name} — ${info}` : name);
}

// ==== [1] THE ONE-SOURCE LAW =================================================

{
  console.log("\n[1] the one-source law (scripts/dev-memory-ceiling.ts)");
  const m = read("scripts/dev-memory-ceiling.ts");

  ok(
    "1a the default ceiling is 2048MB (at/below the kernel kill band's top so the engine collects FIRST; above the settle band's engine share so steady-state never thrashes)",
    DEFAULT_TURBOPACK_MEMORY_MB === 2048,
  );
  ok(
    "1b the env knob contract is named and exported (the ops surface — NEXT_TURBOPACK_MEMORY_MB)",
    TURBOPACK_MEMORY_ENV === "NEXT_TURBOPACK_MEMORY_MB" && m.includes('export const TURBOPACK_MEMORY_ENV'),
  );
  ok(
    "1c the unit law is documented at the source (Next's own comment is quoted: 'A target memory limit for turbo, in bytes')",
    m.includes("A target memory limit for turbo, in bytes"),
  );
  ok(
    "1d the MB floor exists and THROWS (256MB — a smaller value is a unit bug, never a silent crippled dev server)",
    MIN_TURBOPACK_MEMORY_MB === 256 &&
      m.includes("throw new Error") &&
      m.includes("unit bug"),
  );
  ok(
    "1e the conversion is MB->BYTES with no float residue (Math.floor before the multiply)",
    m.includes("Math.floor(mb) * MB_TO_BYTES") && m.includes("1024 * 1024"),
  );
  ok(
    "1f the layered-defense story is at the source (engine ceiling -> guard recycle 2600x3 -> kernel OOM, the R178/R179 evidence cited)",
    m.includes("ENGINE CEILING") &&
      m.includes("2600") &&
      /kernel OOM/i.test(m) &&
      m.includes("1.7-2.2GB"),
  );
}

// ==== [2] THE WIRING LAW =====================================================

{
  console.log("\n[2] the wiring law (next.config.ts)");
  const c = read("next.config.ts");

  ok(
    "2a the config imports the ONE source (no second arithmetic site in the config)",
    c.includes('from "./scripts/dev-memory-ceiling"') &&
      c.includes("turbopackMemoryCeilingBytes"),
  );
  ok(
    "2b the key is passed into experimental.turbopackMemoryLimit (the exact key name Next's schema validates)",
    c.includes("experimental: {") && c.includes("turbopackMemoryLimit: turbopackMemoryCeilingBytes()"),
  );
  ok(
    "2c the config documents the ceiling's provenance (the R180 comment cites the installed consumption sites — no docs-from-memory)",
    c.includes("hot-reloader-turbopack.js") && c.includes("turbopack-build/impl.js"),
  );
  ok(
    "2d no stray MB-looking literal leaked into the config (the value is ONLY the function call)",
    !/turbopackMemoryLimit:\s*\d/.test(c),
  );
}

// ==== [3] THE INSTALLED-NEXT LAW =============================================

{
  console.log("\n[3] the installed-next law (the schema + both consumption sites, re-verified at battery-run time)");
  const schemaPath = "node_modules/next/dist/server/config-schema.js";
  const devReloaderPath = "node_modules/next/dist/server/dev/hot-reloader-turbopack.js";
  const buildImplPath = "node_modules/next/dist/build/turbopack-build/impl.js";

  ok(
    "3a the installed next declares turbopackMemoryLimit in its zod schema (an upgrade that drops the key fails HERE, loudly)",
    existsSync(`${ROOT}/${schemaPath}`) && read(schemaPath).includes("turbopackMemoryLimit"),
  );
  ok(
    "3b the DEV path consumes the key (hot-reloader-turbopack.js passes experimental?.turbopackMemoryLimit into createProject's memoryLimit)",
    existsSync(`${ROOT}/${devReloaderPath}`) &&
      /memoryLimit:\s*.*turbopackMemoryLimit/.test(read(devReloaderPath)),
  );
  ok(
    "3c the BUILD path consumes the key (turbopack-build/impl.js — `bun run build` and build-prod.sh inherit the same ceiling)",
    existsSync(`${ROOT}/${buildImplPath}`) &&
      /memoryLimit:\s*.*turbopackMemoryLimit/.test(read(buildImplPath)),
  );
  ok(
    "3d Next's own source comment ships the unit truth in the .map (in bytes — the quote the one-source law pins)",
    existsSync(`${ROOT}/node_modules/next/dist/server/config-shared.js.map`) &&
      read("node_modules/next/dist/server/config-shared.js.map").includes("A target memory limit for turbo, in bytes"),
  );
}

// ==== [4] THE UNIT LAW (LIVE CONVERSION) =====================================

{
  console.log("\n[4] the unit law (live: conversion, override, floor)");
  const M = 1024 * 1024;

  ok(
    "4a the default converts to BYTES exactly (2048MiB = 2147483648 — the number the dev boot banner echoed)",
    turbopackMemoryCeilingBytes({}) === 2147483648,
  );
  ok(
    "4b the env override converts MB->bytes (2048MB env -> 2147483648 bytes; 3072MB env -> 3221225472)",
    turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "2048" }) === 2147483648 &&
      turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "3072" }) === 3221225472,
  );
  ok(
    "4c a unit bug THROWS at the floor — values below 256MB (e.g. a bytes-scale typo like 200, or 128) are rejected loudly, never a silent crippled dev server",
    (() => {
      try {
        turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "200" });
        return false;
      } catch {
        return true;
      }
    })() &&
      (() => {
        try {
          turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "128" });
          return false;
        } catch {
          return true;
        }
      })() &&
      turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "256" }) === 256 * 1024 * 1024,
  );
  ok(
    "4d empty/blank/garbage env falls back to the default (no Number('') = 0 footgun, no NaN ceiling)",
    turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "" }) === 2147483648 &&
      turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "  " }) === 2147483648 &&
      turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "abc" }) === 2147483648,
  );
  ok(
    "4e fractional MB is floored to whole bytes (2048.9 -> 2147483648, not a float byte count)",
    turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "2048.9" }) === Math.floor(2048.9) * M,
  );
  ok(
    "4f the floor's error message names the env knob and the unit bug (an operator reading dev.log can self-correct)",
    (() => {
      try {
        turbopackMemoryCeilingBytes({ [TURBOPACK_MEMORY_ENV]: "200" });
        return false;
      } catch (e) {
        const msg = String((e as Error).message);
        return msg.includes(TURBOPACK_MEMORY_ENV) && msg.includes("unit bug");
      }
    })(),
  );
}

// ==== [5] THE GUARD'S NEAR-BAND LAW ==========================================

{
  console.log("\n[5] the near-band law (scripts/dev-rss-guard.cjs — the R180 layer-2 tripwire)");
  const g = read("scripts/dev-rss-guard.cjs");

  ok(
    "5a the EARLY_WATER exists with the documented default 2400 (the top of the R178 settle band 2290-2406) and the env knob RSS_GUARD_EARLY_MB",
    g.includes("const EARLY_WATER_MB = Math.max(0, Number(process.env.RSS_GUARD_EARLY_MB) || 2400);"),
  );
  ok(
    "5b the event is a DATA-GENERATOR, never an action (the comment pins 'NEVER recycles' + the recycle law untouched)",
    g.includes("NEVER recycles") && g.includes("no action"),
  );
  ok(
    "5c the rising-edge discipline (fires only on band ENTRY via the nearBandArmed flag; re-arms on a sub-band sample — one event per entry, zero spam)",
    g.includes("!nearBandArmed") && g.includes("nearBandArmed = true") && g.includes("nearBandArmed = false"),
  );
  ok(
    "5d the event carries the evidence fields (rssMb, earlyMb, waterMb, pid — the R111 structured-mirror law)",
    g.includes('kind: "near-band"') &&
      g.includes("rssMb: srv.rssMb, earlyMb: EARLY_WATER_MB, waterMb: HIGH_WATER_MB, pid: srv.pid"),
  );
  ok(
    "5e the standing recycle law is BYTE-PINNED untouched (water 2600, consecutive 3 — the R178 data-driven retune survives)",
    g.includes("const HIGH_WATER_MB = Math.max(50, Number(process.env.RSS_GUARD_WATER_MB) || 2600);") &&
      g.includes("const CONSECUTIVE = Math.max(1, Number(process.env.RSS_GUARD_CONSECUTIVE) || 3);"),
  );
  ok(
    "5f the arm flag resets on a fresh daemon pass (declared once per daemon lifetime, not per-sample — no stale-arm leak across restarts)",
    g.includes("let nearBandArmed = false;") && !g.includes("nearBandArmed = nearBandArmed"),
  );
  ok(
    "5g 0 disables the watch honestly (RSS_GUARD_EARLY_MB=0 -> EARLY_WATER_MB=0 -> the >0 guard skips the branch — the R112 zero-is-meaningful law)",
    g.includes("Math.max(0, Number(process.env.RSS_GUARD_EARLY_MB) || 2400)") &&
      g.includes("EARLY_WATER_MB > 0 &&"),
  );
}

// ==== [6] THE CENSUS + REGISTRATION LAW ======================================

{
  console.log("\n[6] the census + registration law");
  const c = familyCensus();
  ok(
    "6a the family census parses (tsx >= 28 with r180 registered, bun === 2, proofs === 5 — floors, not exact counts)",
    c.tsx >= 28 && c.bun === 2 && c.proofs === 5,
  );
  ok(
    "6b this battery is REGISTERED in run-family.sh's BATTERIES_TSX (the join-day canary lives in the file that can forget — the bare filename is the runner's array shape)",
    assertRegistered("r180-memory-ceiling-check.ts") === true,
  );
  ok(
    "6c the runner manifest includes this suite (the --list resolved manifest and the arrays are ONE source)",
    c.names.includes("r180-memory-ceiling-check.ts"),
  );
}

// ==== VERDICT ================================================================

console.log(`\n=== r180-memory-ceiling-check: ${passed.length} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("ALL GREEN — the OOM-band hardening law holds: engine ceiling wired from ONE source, the installed next verified, the unit bug fenced, the near-band watch armed without touching the recycle law.");

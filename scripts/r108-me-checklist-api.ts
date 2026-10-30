/**
 * R108 — server-persisted checklist dismissal API PROOFS (PATCH /api/v1/me).
 *
 * Covers the contract the dashboard relies on (§406 law: this UI state lives
 * on the server, never localStorage):
 *   A. fixture: register r108-checklist@test.local + session login (real APIs)
 *   B. GET  /api/v1/me unauthenticated            → 401
 *      GET  me (fixture, fresh)                    → checklistDismissedAt: null
 *      PATCH { checklistDismissed: true }            → non-null dismissedAt
 *      GET  me again (persistence)                   → still non-null
 *      PATCH idempotent re-dismiss                   → still non-null
 *      PATCH { checklistDismissed: false }           → cleared (restore)
 *      PATCH with wrong shape ("yes")                → 400 VALIDATION
 *      PATCH { name + checklistDismissed } together  → both applied
 *   C. DB-level truth: User.checklistDismissedAt matches the API view.
 *   D. FK-safe sweep of the fixture + census proof (idempotent re-runs).
 *
 * Run:  bun scripts/r108-me-checklist-api.ts
 * Exit: 0 = all green, 1 = any check failed.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { PrismaClient } from "@prisma/client";
import { callerOf } from "./lib/platform-mfa";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = "r108-checklist@test.local";
const PASS = "Passw0rd!x";
const NAME = "R108 Checklist QA";

type Check = { name: string; ok: boolean; info?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, info?: string) {
  checks.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? ` — ${info}` : ""}`);
}
function envelopeData(json: any): any {
  return json?.data?.user ?? json?.data ?? json?.user ?? json;
}

/* ---------------------------------- A. seed --------------------------------- */

async function seed() {
  const jar = new Map<string, string>();
  const caller = callerOf(jar);
  const reg = await caller("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: NAME,
      email: EMAIL,
      password: PASS,
      acceptedLegal: { terms: true, privacy: true },
    }),
  });
  if (reg.status !== 201) {
    // Idempotent re-runs: 409 EMAIL_IN_USE is fine — just log in below.
    if (reg.status !== 409) throw new Error(`register failed ${reg.status}: ${JSON.stringify(reg.json).slice(0, 200)}`);
  }
  const csrf = await caller("/api/auth/csrf");
  await caller("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf.json?.csrfToken, email: EMAIL, password: PASS }).toString(),
  });
  const me = await caller("/api/v1/me");
  if (me.status !== 200) throw new Error(`fixture login failed ${me.status}`);
  return { jar, caller, userId: envelopeData(me.json)?.id as string };
}

/* ---------------------------------- main ----------------------------------- */

async function main() {
  console.log("── A. seed (register + session login) ──");
  const { caller, userId } = await seed();
  check("A fixture registered + session resolves /api/v1/me", typeof userId === "string" && userId.length > 0, userId);

  console.log("── B. dismissal contract ──");
  const anon = await callerOf(new Map())("/api/v1/me");
  check("B1 GET /api/v1/me unauthenticated → 401", anon.status === 401, `status=${anon.status}`);

  const me0 = await caller("/api/v1/me");
  const d0 = envelopeData(me0.json)?.checklistDismissedAt;
  check("B2 fresh account → checklistDismissedAt null", d0 === null, `value=${JSON.stringify(d0)}`);

  const d1 = await caller("/api/v1/me", {
    method: "PATCH",
    body: JSON.stringify({ checklistDismissed: true }),
  });
  const d1at = envelopeData(d1.json)?.checklistDismissedAt;
  check("B3 PATCH dismissed=true → 200 with non-null dismissedAt", d1.status === 200 && typeof d1at === "string" && d1at.length > 0, `status=${d1.status} at=${d1at}`);

  const me1 = await caller("/api/v1/me");
  check("B4 GET after dismiss → still dismissed (persisted)", typeof envelopeData(me1.json)?.checklistDismissedAt === "string");

  const d2 = await caller("/api/v1/me", { method: "PATCH", body: JSON.stringify({ checklistDismissed: true }) });
  check("B5 idempotent re-dismiss → 200, still non-null", d2.status === 200 && typeof envelopeData(d2.json)?.checklistDismissedAt === "string");

  const d3 = await caller("/api/v1/me", { method: "PATCH", body: JSON.stringify({ checklistDismissed: false }) });
  check("B6 PATCH dismissed=false (restore) → dismissedAt cleared", d3.status === 200 && envelopeData(d3.json)?.checklistDismissedAt === null);

  const bad = await caller("/api/v1/me", { method: "PATCH", body: JSON.stringify({ checklistDismissed: "yes" }) });
  check("B7 wrong shape (string) → 422 VALIDATION_ERROR (envelope law)", bad.status === 422 && bad.json?.error?.code === "VALIDATION_ERROR", `status=${bad.status} code=${bad.json?.error?.code ?? bad.json?.code}`);

  const both = await caller("/api/v1/me", {
    method: "PATCH",
    body: JSON.stringify({ name: "R108 Renamed", checklistDismissed: true }),
  });
  const bothData = envelopeData(both.json);
  check("B8 combined PATCH: name AND dismissal both applied", both.status === 200 && bothData?.name === "R108 Renamed" && typeof bothData?.checklistDismissedAt === "string");

  console.log("── C. DB-level truth ──");
  const row = await db.user.findUnique({ where: { id: userId }, select: { checklistDismissedAt: true } });
  check("C User.checklistDismissedAt non-null in DB (matches API)", row?.checklistDismissedAt instanceof Date);
  // Leave the fixture in the visible state (restore) so re-runs start clean.
  await db.user.update({ where: { id: userId }, data: { checklistDismissedAt: null } });

  console.log("── D. sweep + census ──");
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("bun", ["scripts/r104-user-sweep.mjs"], { encoding: "utf8" });
  const censusLine = out.split("\n").find((l) => l.includes("census after sweep"));
  check("D1 FK-safe sweep removed fixture (pattern-registered)", out.includes("foreign_key_check: 0 violations"), censusLine?.trim());
  check("D2 census restored 7/5, residue 0", censusLine?.includes("users=7 businesses=5") === true && out.includes("residue: 0"), censusLine?.trim());

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr108 me-checklist API proofs: ${checks.length - failed.length}/${checks.length} checks passed`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await db.$disconnect();
  process.exit(1);
});

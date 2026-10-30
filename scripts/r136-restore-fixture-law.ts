/**
 * R136 — RECOVERY: restore the e2e-smoke fixture law "sara owns EXACTLY 1
 * business" after the 2026-10-30 sandbox DB wipe + git-blob restore.
 *
 * Incident: every table was wiped to zero rows (the documented sandbox
 * revert disease, third strike). Recovery restored db/custom.db from the
 * newest git blob (commit 766d32a, 09-28) and pushed the schema forward —
 * that blob predates the deterministic smoke business, so the smoke
 * fixture re-created its own business, leaving sara with TWO businesses.
 * FREE = BUSINESSES_MAX 1 → the smoke suite's throwaway-creation steps
 * would 422 forever after (the r22 failure class).
 *
 * Fix: delete the September-era "Sara's Handmade Shop" through the
 * SANCTIONED API (DELETE /api/v1/businesses/[id] + confirmName) so every
 * FK-safe cascade law of the route applies — never raw DB surgery on a
 * whole business graph.
 *
 * Run: bun scripts/r136-restore-fixture-law.ts
 */
import { PrismaClient } from "@prisma/client";
import { loginCredentials } from "./lib/platform-mfa";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const SARA = "sara@copilot.dev";
const PW = "testpass123";

const STALE = "Sara's Handmade Shop"; // the 09-28-era demo business
const KEEP = "Sara Copilot Business"; // the deterministic smoke business

async function main() {
  const jar = new Map<string, string>();
  const f = async (path: string, init: RequestInit = {}, bizId?: string) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (bizId) headers["x-business-id"] = bizId;
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

  await loginCredentials(f, jar, SARA, PW);
  console.log("[r136] sara logged in");

  const list = await f("/api/v1/businesses");
  const body = await list.json();
  const items: Array<{ business: { id: string; name: string } }> = Array.isArray(body?.data)
    ? body.data
    : (body?.data?.businesses ?? body?.businesses ?? []);
  console.log("[r136] sara businesses:", items.map((i) => i.business.name).join(" | "));

  const stale = items.find((i) => i.business.name === STALE);
  if (!stale) {
    console.log("[r136] stale business not present — nothing to delete");
  } else {
    const del = await f(`/api/v1/businesses/${stale.business.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmName: STALE }),
    }, stale.business.id);
    console.log("[r136] DELETE stale business →", del.status);
    if (del.status !== 200 && del.status !== 201 && del.status !== 204) {
      console.log(await del.text());
      process.exit(1);
    }
  }

  const owned = await db.business.count({ where: { ownerId: (await db.user.findUnique({ where: { email: SARA } }))!.id } });
  const names = await db.business.findMany({ where: { owner: { email: SARA } }, select: { name: true } });
  console.log(`[r136] sara now owns ${owned}: ${names.map((n) => n.name).join(" | ")}`);
  if (owned !== 1 || names[0]?.name !== KEEP) {
    console.error("[r136] LAW STILL BROKEN");
    process.exit(1);
  }
  console.log("[r136] fixture law restored: sara owns exactly 1 (", KEEP, ")");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

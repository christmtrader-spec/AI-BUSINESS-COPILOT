/**
 * r130-rss-bisect.ts — empirical leak bisection (R130 OOM hunt).
 *
 * Fires N sequential requests of ONE class, samples next-server RSS before
 * and after, and reports MB/request. Classes:
 *   health   — GET /api/health (no auth, no DB)
 *   root     — GET / (page render)
 *   authed   — GET /api/v1/businesses (session + DB)
 *   audit401 — GET /api/v1/customers with a bogus session cookie (auth fail path)
 *
 * Usage: bun scripts/r130-rss-bisect.ts <class> <count>
 */
import { spawnSync } from "node:child_process";

const BASE = "http://localhost:3000";

function nextServerRssMb(): number {
  const out = spawnSync("ps", ["-eo", "pid,rss,comm,args"], { encoding: "utf8" });
  let best = 0;
  for (const line of out.stdout.split("\n")) {
    if (!line.includes("next-server")) continue;
    const rss = Number(line.trim().split(/\s+/)[1]);
    if (Number.isFinite(rss) && rss > best) best = rss;
  }
  return Math.round(best / 1024); // KB → MB
}

async function login(email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const cookie0 = csrfRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie0,
    },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      callbackUrl: `${BASE}/`,
      json: "true",
    }),
  });
  const jar = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!jar.includes("next-auth.session-token") && !jar.includes("__Secure-")) {
    throw new Error(`login failed for ${email}: ${res.status}`);
  }
  return jar;
}

const cls = process.argv[2] ?? "health";
const n = Number(process.argv[3] ?? 100);

// Session cookie for authed classes (fixture owner from e2e-smoke seed).
let cookie = "";
let bid = "";
if (cls === "authed" || cls === "audit401") {
  cookie = await login("smkowner@test.local", "Smk-owner-1!");
  const listRes = await fetch(`${BASE}/api/v1/businesses`, {
    headers: { cookie },
  });
  const body = (await listRes.json()) as { data?: Array<{ id: string }> };
  bid = body.data?.[0]?.id ?? "";
}

const rss0 = nextServerRssMb();
const t0 = Date.now();
let statuses: Record<number, number> = {};
for (let i = 0; i < n; i++) {
  let res: Response;
  if (cls === "health") {
    res = await fetch(`${BASE}/api/health`);
  } else if (cls === "root") {
    res = await fetch(`${BASE}/`);
  } else if (cls === "authed") {
    res = await fetch(`${BASE}/api/v1/businesses`, {
      headers: { cookie, "x-business-id": bid },
    });
  } else {
    res = await fetch(`${BASE}/api/v1/customers`, {
      headers: { cookie: "next-auth.session-token=bogus-token-value" },
    });
  }
  await res.arrayBuffer();
  statuses[res.status] = (statuses[res.status] ?? 0) + 1;
}
const rss1 = nextServerRssMb();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `class=${cls} n=${n} ${secs}s statuses=${JSON.stringify(statuses)} rss ${rss0}MB -> ${rss1}MB delta=${rss1 - rss0}MB (${((rss1 - rss0) / n).toFixed(2)}MB/req)`,
);

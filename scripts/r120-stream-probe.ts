/**
 * R120 — one-shot stream probe: login as the QA persona, POST the copilot
 * stream endpoint, and print the RAW response so a server-side failure the
 * browser localizes away becomes visible.
 */
const BASE = "http://localhost:3000";
const jar = new Map<string, string>();

async function f(path: string, init: RequestInit = {}, bizId?: string) {
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
}

// Real credentials flow: CSRF then form-encoded callback.
await f("/api/auth/csrf");
const csrfRes = await f("/api/auth/csrf");
const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
const login = await f("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    csrfToken,
    email: "r118-qa@test.local",
    password: "R118-Qa-2026!",
  }).toString(),
});
console.log("login:", login.status, jar.has("next-auth.session-token") ? "session-ok" : "NO-SESSION");

const bizs = (await (await f("/api/v1/businesses")).json()) as {
  data?: { business?: { id: string } }[];
};
const bizId = bizs?.data?.[0]?.business?.id;
console.log("businesses:", bizId ?? "NONE");

// Summary first (proves the snapshot's input side is healthy).
const sum = await f("/api/v1/reports/summary?days=30", {}, bizId);
console.log("summary:", sum.status);
if (sum.status !== 200) {
  console.log(await sum.text());
  process.exit(1);
}

// Now the stream — print status + first bytes.
const stream = await f("/api/v1/copilot/stream", { method: "POST", body: JSON.stringify({ question: "How did revenue change vs the previous 30 days?" }) }, bizId);
console.log("stream status:", stream.status, stream.headers.get("content-type"));
const text = await stream.text();
console.log("stream body head:", text.slice(0, 800));

// Keep this file a standalone module (tsc: top-level names must not collide
// with e2e-smoke.ts's block-scoped globals).
export {};

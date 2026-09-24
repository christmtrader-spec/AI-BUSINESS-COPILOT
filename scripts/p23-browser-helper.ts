/**
 * scripts/p23-browser-helper.ts — one-off driver for agent-browser E2E of
 * the Prompt 23 payment return flow. Logs in as the pay22 browser fixture
 * user, then performs ONE action:
 *   bun scripts/p23-browser-helper.ts create           → prints session id
 *   bun scripts/p23-browser-helper.ts succeed <id>     → simulate success
 *   bun scripts/p23-browser-helper.ts fail <id>        → simulate failure
 *   bun scripts/p23-browser-helper.ts mismatch <id>    → currency-mismatch webhook
 *   bun scripts/p23-browser-helper.ts back-free        → internal switch to FREE
 */
export {};

const BASE = "http://localhost:3000";
const EMAIL = "pay22.browser@t.dev";
const PASSWORD = "Pay22!Browser2026";
const IP = `10.211.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function newJar() {
  const c = new Map();
  return {
    capture(res: Response) {
      const raw = [
        ...((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []),
        res.headers.get("set-cookie") ?? "",
      ].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) c.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...c.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(s: string) {
      for (const [k, v] of c) if (k.endsWith(s)) return v;
      return null;
    },
  };
}

async function api(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; jar?: ReturnType<typeof newJar> } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "x-forwarded-for": IP,
      ...(opts.body !== undefined && typeof opts.body !== "string" ? { "content-type": "application/json" } : {}),
      ...(opts.jar ? { cookie: opts.jar.header() } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  if (opts.jar) opts.jar.capture(res);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

const [, , action, arg] = process.argv;
const jar = newJar();
const csrf = await api("/api/auth/csrf", { jar });
const rawCookie = jar.get("csrf-token");
const token = rawCookie ? decodeURIComponent(rawCookie).split("|")[0] : csrf.json?.csrfToken;
const li = await api("/api/auth/callback/credentials", {
  method: "POST",
  jar,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken: token!, email: EMAIL, password: PASSWORD, callbackUrl: `${BASE}/`, json: "true" }).toString(),
});
if (!jar.get("session-token")) {
  console.error(`login failed (${li.status})`);
  process.exit(1);
}
const bizs = await api("/api/v1/businesses", { jar });
const list = (bizs.json?.data?.items ?? bizs.json?.data ?? []) as Array<{ business: { id: string; name: string } }>;
const biz = list[0]?.business;
if (!biz) {
  console.error("no business found");
  process.exit(1);
}
const ctx = { "x-business-id": biz.id };

if (action === "create") {
  const co = await api("/api/v1/billing/checkout", { method: "POST", jar, headers: ctx, body: { planCode: "STARTER", billingPeriod: "MONTHLY" } });
  if (co.status !== 201) {
    console.error(`checkout failed ${co.status}: ${co.text.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(co.json.data.checkoutSession.id);
} else if (action === "succeed" || action === "fail") {
  const sim = await api(`/api/v1/billing/checkout/${arg}/simulate`, { method: "POST", jar, headers: ctx, body: { outcome: action === "succeed" ? "succeeded" : "failed" } });
  console.log(`${action}: ${sim.status} ${(sim.text || "").slice(0, 160)}`);
} else if (action === "mismatch") {
  // Self-contained signed mock webhook (no .ts imports — tsc excludes scripts
  // that run under bun; replicates buildMockEventBody/buildMockEventHeaders).
  const { createHmac, randomUUID } = await import("node:crypto");
  const envPath = new URL("../.env", import.meta.url).pathname;
  const envText = await import("node:fs").then((fs) => fs.readFileSync(envPath, "utf8"));
  const nextAuthSecret = envText.split("\n").find((l) => l.startsWith("NEXTAUTH_SECRET="))?.slice("NEXTAUTH_SECRET=".length).trim() ?? "";
  const secret = createHmac("sha256", "payments:webhook-secret").update(nextAuthSecret || "insecure-dev-fallback-secret").digest("hex");
  const body = JSON.stringify({
    id: `evt_mock_${randomUUID()}`,
    type: "checkout.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: { checkoutSessionId: arg, amountMinor: 900, currency: "USD" },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const wh = await api("/api/v1/webhooks/payments/mock", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "mock-signature": sig },
  });
  console.log(`mismatch webhook: ${wh.status} ${(wh.text || "").slice(0, 160)}`);
} else if (action === "back-free") {
  const r = await api("/api/v1/billing/change-plan", { method: "POST", jar, headers: ctx, body: { planCode: "FREE" } });
  console.log(`back-free: ${r.status} ${(r.text || "").slice(0, 160)}`);
} else {
  console.error("unknown action");
  process.exit(1);
}

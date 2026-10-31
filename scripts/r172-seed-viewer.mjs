/**
 * R172 — seed a VIEWER member into the QA persona's shop through the REAL
 * product flows (register → owner mints invite link → viewer accepts), so
 * the read-only gate of the new header quick-create menu can be proven
 * LIVE (the same gate the dashboard quick-actions toolbar has used since
 * Prompt 52).
 *
 * Confined to the R156 QA Shop (the standing census discipline): one new
 * User row + one VIEWER BusinessMember row, clearly named r172-viewer.
 */
const BASE = "http://localhost:3000";
const EMAIL = "r172-viewer@test.local";
const PASS = "R172-Viewer-2026!";

function jar() {
  let cookie = "";
  return {
    async fetch(path, init = {}) {
      // redirect:"manual" — NextAuth sets the session cookie on the 302;
      // following the redirect loses it (the smoke suite's own lesson).
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        redirect: "manual",
        headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) {
        cookie = [...new Set([...cookie.split("; ").filter(Boolean), ...set.map((c) => c.split(";")[0])])].join("; ");
      }
      return res;
    },
  };
}

async function login(email, password) {
  const s = jar();
  const csrf = await s.fetch("/api/auth/csrf").then((r) => r.json());
  const res = await s.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password }),
  });
  // 302 = NextAuth's success redirect (the smoke suite accepts 302 or 200).
  if (res.status !== 302 && res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return s;
}

const shopId = process.argv[2];
if (!shopId) throw new Error("usage: bun scripts/r172-seed-viewer.mjs <qaShopId>");

// 1. Register the viewer (idempotent: 201 fresh / 409 already exists).
const reg = await fetch(`${BASE}/api/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "R172 Viewer", email: EMAIL, password: PASS }),
});
console.log("register:", reg.status, reg.status === 409 ? "(already exists — ok)" : "");

// 2. Owner mints a VIEWER invite link for the QA shop.
const owner = await login("r156-qa@test.local", "R156-QA-2026!");
const mint = await owner.fetch(`/api/v1/businesses/${shopId}/invites`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-business-id": shopId },
  body: JSON.stringify({ role: "VIEWER", expiresInDays: 1 }),
});
const mintBody = await mint.json();
const token = mintBody?.data?.token;
console.log("mint invite:", mint.status, token ? `token len ${token.length}` : JSON.stringify(mintBody).slice(0, 120));
if (!token) process.exit(1);

// 3. Viewer previews + accepts.
const viewer = await login(EMAIL, PASS);
const preview = await viewer.fetch(`/api/v1/invites/${token}`);
const pb = await preview.json();
console.log("preview:", preview.status, pb?.data?.status, "callerIsMember:", pb?.data?.callerIsMember, "role:", pb?.data?.role);
const accept = await viewer.fetch(`/api/v1/invites/${token}`, { method: "POST" });
console.log("accept:", accept.status);
const ab = await accept.json().catch(() => ({}));
console.log("accepted role:", ab?.data?.role ?? JSON.stringify(ab).slice(0, 120));

// 4. Confirm membership from the viewer's own /memberships view.
const me = await viewer.fetch("/api/v1/businesses");
const mb = await me.json();
const rows = (mb?.data ?? []).map((m) => ({ shop: m.business?.name, role: m.role }));
console.log("viewer memberships:", JSON.stringify(rows));

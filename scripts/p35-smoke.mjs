/** Quick CRM API smoke — create user/biz, exercise endpoints, clean up. */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const PASS = "testpass123";
const db = new PrismaClient();
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
function jarFetch(jar) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": "10.47.1.2", ...(init.headers ?? {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { ...init, headers: cookie ? { ...headers, cookie } : headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
    }
    return res;
  };
}
async function login(jar, email, password) {
  const f = jarFetch(jar);
  const { csrfToken } = await (await f("/api/auth/csrf")).json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true" });
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
}
const run = `sm${Math.floor(Math.random() * 1e9)}`;
const email = `p35-smoke-${run}@test.local`;
const jar = new Map();
const f = jarFetch(jar);

const reg = await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P35 Smoke", email, password: PASS }) });
console.log("register:", reg.status);
await login(jar, email, PASS);
const bizRes = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `P35SMOKE-${run}`, currencyCode: "USD", locale: "en" }) });
const bizBody = await bizRes.json();
const bizId = bizBody?.data?.business?.id ?? bizBody?.data?.id;
console.log("biz:", bizRes.status, bizId);
const wb = (path, init = {}) => f(path, { ...init, headers: { "x-business-id": bizId, ...(init.headers ?? {}) } });
const j = async (path, init = {}) => { const r = await wb(path, init); let b = null; try { b = await r.json(); } catch {} return { status: r.status, b }; };

const lead = await j("/api/v1/crm/leads", { method: "POST", body: JSON.stringify({ name: "Smoke Lead", source: "MANUAL", phone: "+989120000000" }) });
console.log("lead create:", lead.status, JSON.stringify(lead.b).slice(0, 200));
const leadId = lead.b?.data?.id;
console.log("lead list:", (await j("/api/v1/crm/leads?pageSize=5")).status);
console.log("lead detail:", (await j(`/api/v1/crm/leads/${leadId}`)).status);
console.log("bad status:", JSON.stringify(await j(`/api/v1/crm/leads/${leadId}/status`, { method: "POST", body: JSON.stringify({ status: "CONVERTED" }) })).slice(0, 160));
console.log("contacted:", JSON.stringify(await j(`/api/v1/crm/leads/${leadId}/status`, { method: "POST", body: JSON.stringify({ status: "CONTACTED" }) })).slice(0, 100));
const opp = await j("/api/v1/crm/opportunities", { method: "POST", body: JSON.stringify({ title: "Smoke Opp", leadId, expectedValueMinor: 10000, probabilityPct: 75 }) });
console.log("opp create:", opp.status, JSON.stringify(opp.b?.data ?? opp.b).slice(0, 200));
const oppId = opp.b?.data?.id;
console.log("opp list:", (await j("/api/v1/crm/opportunities")).status);
console.log("opp won (no customer):", JSON.stringify(await j(`/api/v1/crm/opportunities/${oppId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) })).slice(0, 140));
const cust = await j("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Smoke Cust" }) });
const custId = cust.b?.data?.id;
console.log("opp patch customer:", (await j(`/api/v1/crm/opportunities/${oppId}`, { method: "PATCH", body: JSON.stringify({ customerId: custId }) })).status);
console.log("opp WON:", JSON.stringify(await j(`/api/v1/crm/opportunities/${oppId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) })).slice(0, 120));
console.log("opp LOST without reason:", JSON.stringify(await j(`/api/v1/crm/opportunities/${oppId}/stage`, { method: "POST", body: JSON.stringify({ stage: "LOST" }) })).slice(0, 140));
console.log("reopen:", JSON.stringify(await j(`/api/v1/crm/opportunities/${oppId}/stage`, { method: "POST", body: JSON.stringify({ stage: "PROPOSAL" }) })).slice(0, 120));
const conv = await j(`/api/v1/crm/leads/${leadId}/convert`, { method: "POST", body: JSON.stringify({ mode: "EXISTING_CUSTOMER", customerId: custId }) });
console.log("convert:", conv.status, JSON.stringify(conv.b?.data?.status ?? conv.b).slice(0, 120));
console.log("summary:", JSON.stringify(await j("/api/v1/crm/summary")).slice(0, 400));
console.log("sales before check — sale count:", (await j("/api/v1/sales")).b?.data?.total);
// cross-tenant: second user
const email2 = `p35-smoke2-${run}@test.local`;
const jar2 = new Map();
const f2 = jarFetch(jar2);
await f2("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P35 Smoke2", email: email2, password: PASS }) });
await login(jar2, email2, PASS);
const biz2 = await f2("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `P35SMOKE2-${run}`, currencyCode: "USD", locale: "en" }) });
const biz2Body = await biz2.json();
const biz2Id = biz2Body?.data?.business?.id ?? biz2Body?.data?.id;
const wb2 = (path, init = {}) => f2(path, { ...init, headers: { "x-business-id": biz2Id, ...(init.headers ?? {}) } });
const foreign = await wb2(`/api/v1/crm/leads/${leadId}`);
console.log("foreign lead:", foreign.status);
const foreignOpp = await wb2(`/api/v1/crm/opportunities/${oppId}`);
console.log("foreign opp:", foreignOpp.status);

// cleanup
await db.business.deleteMany({ where: { name: { startsWith: "P35SMOKE-" } } });
await db.business.deleteMany({ where: { name: { startsWith: "P35SMOKE2-" } } });
await db.user.deleteMany({ where: { email: { contains: "p35-smoke" } } });
const leftovers = await db.user.count({ where: { email: { contains: "p35-smoke" } } });
console.log("cleanup:", leftovers === 0 ? "CLEAN" : `LEFTOVER ${leftovers}`);
await db.$disconnect();

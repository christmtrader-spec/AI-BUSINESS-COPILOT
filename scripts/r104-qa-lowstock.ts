/**
 * R104 one-off: push the r103 probe book's throne product into LOW STOCK so
 * the dashboard tile's amber attention line renders for QA, then restore.
 * Modes: --low  (stockQty 0)   --restore  (stockQty back to 120)
 */
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const db = new PrismaClient();
const EMAIL = "r103-tile-probe@qa.local";
const PASS = "testpass123";

function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "x-forwarded-for": "10.234.1.9",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  };
}

const restore = process.argv.includes("--restore");
const qty = restore ? 120 : 0;

async function main() {
  const user = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const biz = await db.business.findFirstOrThrow({ where: { ownerId: user.id } });
  const jar = new Map<string, string>();
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASS }).toString(),
  });
  const products = await db.product.findMany({
    where: { businessId: biz.id, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const target = products[0];
  if (!target) throw new Error("no products in probe book");
  const res = await f(`/api/v1/products/${target.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-business-id": biz.id },
    body: JSON.stringify({ stockQty: qty }),
  });
  console.log(`${restore ? "restore" : "low"}: ${target.name} stockQty -> ${qty} (HTTP ${res.status})`);
  process.exit(res.status < 300 ? 0 : 1);
}
main();

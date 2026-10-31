/**
 * scripts/r156-qa-journey.mjs — R156 LIVE QA (Playwright).
 *
 * THE MONTH ROWS FIND THEIR LISTS — the journey:
 *   EN/light: perf panel → Sales performance → Group by Month (window
 *   2026-08-01..2026-10-31) → the ONE hint + three month rows → click
 *   "Oct 2026" → #/sales?month=2026-10 (the sales month chip + the list
 *   filtered to the API's OWN total) → Expense breakdown → Month → click
 *   "Sep 2026" → #/expenses?month=2026-09 (the expenses month chip) →
 *   Group by Day → the day table carries NO hint and NO navigation.
 *   FA/dark/RTL: the Persian hint frame + the month row drill landing.
 *
 * Persona: the FIXED R156 fixture (scripts/r156-qa-seed.mjs — run it first).
 * Usage: node scripts/r156-qa-journey.mjs   (BASE via QA_BASE, default :3000)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const EMAIL = process.env.QA_EMAIL ?? "r156-qa@test.local";
const PASSWORD = process.env.QA_PASSWORD ?? "R156-QA-2026!";
const OUT = process.env.QA_OUT ?? "download/qa-r156";
mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (name, cond, info = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
};

// ---- Node-side session (data-driven expectations) --------------------------
const jar = new Map();
const absorb = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
};
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function nodeApi(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: cookieHeader(), ...(init.headers ?? {}) },
  });
  absorb(res);
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: res.status, body: null };
  }
}
{
  const csrf = await nodeApi("/api/auth/csrf");
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: new URLSearchParams({
      csrfToken: csrf.body?.csrfToken ?? "",
      email: EMAIL,
      password: PASSWORD,
      callbackUrl: `${BASE}/`,
      json: "true",
    }).toString(),
  });
  absorb(res);
}
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
const owner = await prisma.user.findUnique({
  where: { email: EMAIL },
  select: { memberships: { select: { role: true, business: { select: { id: true } } } } },
});
const BID = owner?.memberships?.find((m) => m.role === "OWNER")?.business?.id;
ok("fixture business resolves", !!BID);
const salesOct = (await nodeApi(`/api/v1/sales?month=2026-10&page=1&pageSize=50`, { headers: { "x-business-id": BID } })).body?.data?.total;
const expSep = (await nodeApi(`/api/v1/expenses?month=2026-09&page=1&pageSize=50`, { headers: { "x-business-id": BID } })).body?.data?.total;
ok("data-driven expectations resolve (Oct sales / Sep expenses)", salesOct > 0 && expSep > 0, `oct ${salesOct}, sep ${expSep}`);

const browser = await chromium.launch();

// ---- EN/light journey -------------------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/#/login`);
await page.fill("input[type=email]", EMAIL);
await page.fill("input[type=password]", PASSWORD);
await page.click("button[type=submit]");
await page.waitForTimeout(3000);

await page.goto(`${BASE}/#/reports`);
await page.waitForTimeout(2500);
await page.getByRole("combobox", { name: "Report type" }).click();
await page.getByRole("option", { name: "Sales performance" }).click();
await page.waitForTimeout(1500);
await page.getByRole("combobox", { name: "Group by" }).click();
await page.getByRole("option", { name: "Month", exact: true }).click();
await page.waitForTimeout(1200);

// Widen the window so THREE months render (the default window is 30 days).
await page.getByLabel("From", { exact: true }).fill("2026-08-01");
await page.getByLabel("To", { exact: true }).fill("2026-10-31");
await page.getByRole("button", { name: "Apply" }).click();
await page.waitForTimeout(2000);

const salesHint = page.locator('[data-testid="perf-sales-month-drill-hint"]');
ok("EN sales: the ONE month hint renders", await salesHint.isVisible());
ok(
  "EN sales: the hint names the destination (the Sales workspace)",
  ((await salesHint.textContent()) ?? "").includes("Sales workspace"),
);
const octRow = page.getByRole("row").filter({ hasText: "Oct 2026" });
ok("EN sales: the Oct 2026 month row renders", (await octRow.count()) > 0);
await page.screenshot({ path: `${OUT}/en-light-sales-month-table.png` });

await octRow.first().click();
await page.waitForTimeout(1800);
ok("EN sales: the row lands on #/sales?month=2026-10", page.url().includes("#/sales?month=2026-10"), page.url());
ok("EN sales: the sales month chip renders", await page.locator('[data-testid="sales-month-chip"]').isVisible());
const salesListed = await page.locator('[data-view="module:sales"] table tbody tr').count();
ok(
  "EN sales: the worklist shows exactly that month's sales",
  salesListed === salesOct,
  `listed ${salesListed}, api total ${salesOct}`,
);
await page.screenshot({ path: `${OUT}/en-light-sales-month-landing.png` });

// Expenses side: month row → the expenses workspace month filter.
await page.goto(`${BASE}/#/reports`);
await page.waitForTimeout(2000);
await page.getByRole("combobox", { name: "Report type" }).click();
await page.getByRole("option", { name: "Expense breakdown" }).click();
await page.waitForTimeout(1500);
await page.getByRole("combobox", { name: "Group by" }).click();
await page.getByRole("option", { name: "Month", exact: true }).click();
await page.waitForTimeout(800);
await page.getByLabel("From", { exact: true }).fill("2026-08-01");
await page.getByLabel("To", { exact: true }).fill("2026-10-31");
await page.getByRole("button", { name: "Apply" }).click();
await page.waitForTimeout(2000);

const expHint = page.locator('[data-testid="perf-expenses-month-drill-hint"]');
ok("EN expenses: the ONE month hint renders", await expHint.isVisible());
const sepRow = page.getByRole("row").filter({ hasText: "Sep 2026" });
ok("EN expenses: the Sep 2026 month row renders", (await sepRow.count()) > 0);
await sepRow.first().click();
await page.waitForTimeout(1800);
ok("EN expenses: the row lands on #/expenses?month=2026-09", page.url().includes("#/expenses?month=2026-09"), page.url());
ok("EN expenses: the expenses month chip renders", await page.locator('[data-testid="expenses-month-chip"]').isVisible());
const expListed = await page.locator('[data-view="module:expenses"] table tbody tr').count();
ok(
  "EN expenses: the list shows exactly that month's expenses",
  expListed === expSep,
  `listed ${expListed}, api total ${expSep}`,
);
await page.screenshot({ path: `${OUT}/en-light-expenses-month-landing.png` });

// Day silence: the day table carries NO hint and its rows do not navigate.
await page.goto(`${BASE}/#/reports`);
await page.waitForTimeout(2000);
await page.getByRole("combobox", { name: "Report type" }).click();
await page.getByRole("option", { name: "Expense breakdown" }).click();
await page.waitForTimeout(1500);
await page.getByRole("combobox", { name: "Group by" }).click();
await page.getByRole("option", { name: "Day", exact: true }).click();
await page.waitForTimeout(800);
await page.getByLabel("From", { exact: true }).fill("2026-10-01");
await page.getByLabel("To", { exact: true }).fill("2026-10-31");
await page.getByRole("button", { name: "Apply" }).click();
await page.waitForTimeout(2000);
ok(
  "EN day: NO month hint renders on the day grouping (honest silence)",
  !(await page.locator('[data-testid="perf-expenses-month-drill-hint"]').isVisible().catch(() => false)),
);
const dayRow = page.getByRole("row").filter({ hasText: "Oct 7" }).first();
const urlBefore = page.url();
if (await dayRow.isVisible().catch(() => false)) {
  await dayRow.click();
  await page.waitForTimeout(1200);
}
ok("EN day: clicking a day row does NOT navigate (URL unchanged)", page.url() === urlBefore, page.url());
await page.screenshot({ path: `${OUT}/en-light-day-silence.png` });
await ctx.close();

// ---- FA/dark/RTL journey ----------------------------------------------------
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx2.addInitScript(() => {
  window.localStorage.setItem("theme", "dark");
  window.localStorage.setItem(
    "abc-preferences",
    JSON.stringify({ state: { locale: "fa", activeBusinessId: null, recentViews: [] }, version: 0 }),
  );
});
const page2 = await ctx2.newPage();
await page2.goto(`${BASE}/#/login`);
await page2.fill("input[type=email]", EMAIL);
await page2.fill("input[type=password]", PASSWORD);
await page2.click("button[type=submit]");
await page2.waitForTimeout(3000);

ok("FA locale active (html dir=rtl)", (await page2.locator("html").getAttribute("dir")) === "rtl");
await page2.goto(`${BASE}/#/reports`);
await page2.waitForTimeout(2500);
await page2.getByRole("combobox", { name: /نوع گزارش|Report type/ }).click();
await page2.getByRole("option", { name: /تفکیک هزینه|Expense breakdown/ }).click();
await page2.waitForTimeout(1500);
await page2.getByRole("combobox", { name: /گروه‌بندی بر اساس|Group by/ }).click();
await page2.getByRole("option", { name: "ماه", exact: true }).click();
await page2.waitForTimeout(800);
await page2.getByRole("textbox", { name: "از", exact: true }).fill("2026-08-01");
await page2.getByRole("textbox", { name: "تا", exact: true }).fill("2026-10-31");
await page2.getByRole("button", { name: "اعمال", exact: true }).click();
await page2.waitForTimeout(2000);

const faHint = page2.locator('[data-testid="perf-expenses-month-drill-hint"]');
ok(
  "FA: the month hint renders in Persian (the family frame)",
  ((await faHint.textContent()) ?? "").includes("ردیفی را باز کنید") &&
    ((await faHint.textContent()) ?? "").includes("میز کار هزینه‌ها"),
  (await faHint.textContent()) ?? "",
);
await page2.screenshot({ path: `${OUT}/fa-dark-month-table.png` });

// fa-IR formats 2026-09-01 as شهریور ۱۴۰۵ (the Solar Hijri default) — the
// row's OWN label is the expectation (the journey clicked مهر first and
// landed on 2026-10: the DRILL was right, the selector was wrong).
const faMonthRow = page2.getByRole("row").filter({ hasText: "شهریور" }).first();
if (await faMonthRow.isVisible().catch(() => false)) {
  await faMonthRow.click();
  await page2.waitForTimeout(1800);
}
ok("FA: the row lands on the expenses month deep link", page2.url().includes("#/expenses?month=2026-09"), page2.url());
ok("FA: the expenses month chip renders", await page2.locator('[data-testid="expenses-month-chip"]').isVisible());
await page2.screenshot({ path: `${OUT}/fa-dark-month-landing.png` });
await ctx2.close();

await browser.close();
await prisma.$disconnect();
console.log(`\nr156-qa-journey: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

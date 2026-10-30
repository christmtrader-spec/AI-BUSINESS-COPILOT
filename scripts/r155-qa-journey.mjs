/**
 * scripts/r155-qa-journey.mjs — R155 LIVE QA (Playwright fallback — the
 * agent-browser daemon was down this round).
 *
 * The journey: perf panel (Expense breakdown → Category) → click the
 * "Materials" row → #/expenses?category=Materials (the amber facet chip +
 * exactly the category's rows) → clear → bare #/expenses → the composed
 * month+facet deep link → BOTH chips → clear the month → the category
 * STAYS (each chip clears only itself). Then FA/dark/RTL: the Persian chip
 * + the perf row drill landing.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const EMAIL = "r136-qa-1793388257266@test.local";
const PASSWORD = "R136-QA-2026!";
const OUT = "download/qa-r155";
mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (name, cond, info = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
};

const browser = await chromium.launch();

// ---- EN/light journey -----------------------------------------------------
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
await page.getByRole("option", { name: "Expense breakdown" }).click();
await page.waitForTimeout(2500);

const materialsRow = page.getByRole("row").filter({ hasText: "Materials" });
ok("perf category table shows the Materials row", (await materialsRow.count()) > 0);
ok("the ONE discovery hint renders", await page.locator('[data-testid="perf-category-drill-hint"]').isVisible());
await page.screenshot({ path: `${OUT}/en-light-perf-category.png` });

await materialsRow.first().click();
await page.waitForTimeout(1500);
ok("the row lands on #/expenses?category=Materials", page.url().includes("#/expenses?category=Materials"), page.url());
const chip = page.locator('[data-testid="expenses-category-chip"]');
ok("the amber facet chip renders", await chip.isVisible());
const chipText = (await chip.textContent()) ?? "";
ok("the chip names the category verbatim", chipText.includes("Materials"), chipText);
const dataRows = page.locator('[data-view="module:expenses"] table tbody tr');
const rowCount = await dataRows.count();
ok("the list shows exactly the category's expenses", rowCount === 1, String(rowCount));
ok("the row's own category cell agrees", (await dataRows.first().textContent())?.includes("Materials") === true);
await page.screenshot({ path: `${OUT}/en-light-facet-landing.png` });

await chip.locator("button").click();
await page.waitForTimeout(1200);
ok("clear returns to bare #/expenses", page.url().endsWith("#/expenses"), page.url());
ok("the chip is gone", !(await page.locator('[data-testid="expenses-category-chip"]').isVisible().catch(() => false)));

// compose: month + category, then the decay law LIVE
const now = new Date();
const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
await page.goto(`${BASE}/#/expenses?month=${ym}&category=Materials`);
await page.waitForTimeout(1800);
ok("BOTH chips render (the facets compose)",
  (await page.locator('[data-testid="expenses-month-chip"]').isVisible()) &&
  (await page.locator('[data-testid="expenses-category-chip"]').isVisible()));
await page.locator('[data-testid="expenses-month-chip"] button').click();
await page.waitForTimeout(1200);
ok("month clears, category STAYS (each chip clears only itself)",
  !(await page.locator('[data-testid="expenses-month-chip"]').isVisible().catch(() => false)) &&
  (await page.locator('[data-testid="expenses-category-chip"]').isVisible()));
await page.screenshot({ path: `${OUT}/en-light-decay.png` });
await ctx.close();

// ---- FA/dark/RTL journey --------------------------------------------------
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
await page2.goto(`${BASE}/#/expenses?category=Materials`);
await page2.waitForTimeout(2000);
const chip2 = page2.locator('[data-testid="expenses-category-chip"]');
ok("FA: the facet chip renders", await chip2.isVisible());
const faText = (await chip2.textContent()) ?? "";
ok("FA: the label frame is Persian (the data value stays verbatim)",
  faText.includes("نمایش هزینه‌های دستهٔ") && faText.includes("Materials"), faText);
await page2.screenshot({ path: `${OUT}/fa-dark-facet-landing.png` });

await page2.goto(`${BASE}/#/reports`);
await page2.waitForTimeout(2500);
await page2.getByRole("combobox", { name: /نوع گزارش|Report type/ }).click();
await page2.getByRole("option", { name: /تفکیک هزینه|Expense breakdown/ }).click();
await page2.waitForTimeout(2500);
const faRow = page2.getByRole("row").filter({ hasText: "Materials" });
ok("FA: the perf category table shows Materials", (await faRow.count()) > 0);
ok("FA: the hint renders in Persian",
  ((await page2.locator('[data-testid="perf-category-drill-hint"]').textContent()) ?? "").includes("ردیفی را باز کنید"));
await faRow.first().click();
await page2.waitForTimeout(1500);
ok("FA: the row lands on the same facet deep link", page2.url().includes("#/expenses?category=Materials"), page2.url());
await page2.screenshot({ path: `${OUT}/fa-dark-drill-landing.png` });
await ctx2.close();

await browser.close();
console.log(`\nr155-qa-journey: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

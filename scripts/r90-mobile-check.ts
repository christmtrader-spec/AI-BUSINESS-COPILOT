/**
 * scripts/r90-mobile-check.ts — R90 mobile 390 probe (Playwright).
 * Verifies zero horizontal overflow + the draft/badge language at 390px
 * on the sales list and the customer 360 (FA/RTL, dark), reusing the
 * --keep fixture session.
 * Run: bun scripts/r90-mobile-check.ts   (fixture must exist via --keep)
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const EMAIL = "r90-draft-probe@qa.local";
const PASS = "testpass123";

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

async function main() {
  const biz = await db.business.findFirst({ where: { name: "R90 Draft Probe Co" } });
  if (!biz) throw new Error("keep-fixture missing — run the proofs with --keep first");
  const customerId = (
    await db.customer.findFirst({ where: { businessId: biz.id, name: "Akar Industrial" } })
  )!.id;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  // UI-form login (the honest path), then seed preferences + reload.
  await page.goto(`${BASE}/#/login`);
  await page.waitForTimeout(1500);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(PASS);
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    localStorage.setItem(
      "abc-preferences",
      JSON.stringify({ state: { locale: "fa", theme: "dark" }, version: 0 }),
    );
    localStorage.setItem("theme", "dark");
  });
  await page.reload();
  await page.waitForTimeout(2500);

  const results: string[] = [];
  const check = async (name: string, path: string) => {
    await page.goto(`${BASE}/#${path}`);
    // The store hydrates on load — the first goto applies the seeded
    // preferences only after a full reload (hash-only nav keeps EN/light).
    await page.waitForTimeout(1200);
    await page.reload();
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => ({
      w: document.documentElement.clientWidth,
      sw: document.documentElement.scrollWidth,
      dir: document.documentElement.dir,
      dark: document.documentElement.classList.contains("dark"),
    }));
    const overflow = m.sw > m.w;
    if (overflow) {
      // Diagnose: name the widest offenders at measurement time.
      const off = await page.evaluate(() => {
        const out: Array<{ tag: string; cls: string; right: number; left: number; text: string }> = [];
        document.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          // RTL overflows extend LEFT (negative x) — check both edges.
          if (r.right > 391 || r.left < -1) {
            out.push({
              tag: el.tagName,
              cls: String(el.className).slice(0, 70),
              right: Math.round(r.right),
              left: Math.round(r.left),
              text: (el.textContent || "").slice(0, 30),
            });
          }
        });
        return out.slice(0, 8);
      });
      results.push(`offenders: ${JSON.stringify(off)}`);
    }
    results.push(`${name}: ${m.w}/${m.sw} dir=${m.dir} dark=${m.dark} ${overflow ? "OVERFLOW!" : "no overflow"}`);
    return !overflow;
  };

  const a = await check("sales-list", "/sales");
  await page.screenshot({ path: "qa/qa-r90-mobile390-sales-fa-dark.png" });
  const b = await check("customer-360", `/customers/${customerId}`);
  await page.screenshot({ path: "qa/qa-r90-mobile390-360-fa-dark.png" });

  // The draft badge + overdue badge at 390 on the FA/dark 360
  const badges = await page.evaluate(() => {
    const draft = [...document.querySelectorAll("[data-testid=status-draft-badge]")].map(
      (b) => b.textContent?.trim(),
    );
    const overdue = [...document.querySelectorAll("[data-testid=entity-sale-overdue-badge]")].map(
      (b) => b.textContent?.trim(),
    );
    const strip = document.querySelector("[data-testid=customer-overdue-strip]");
    return { draft, overdue, stripVisible: !!strip };
  });
  results.push(`badges: draft=${JSON.stringify(badges.draft)} overdue=${JSON.stringify(badges.overdue)} strip=${badges.stripVisible}`);

  console.log(results.join("\n"));
  await browser.close();
  await db.$disconnect();
  process.exit(a && b ? 0 : 1);
}

main();

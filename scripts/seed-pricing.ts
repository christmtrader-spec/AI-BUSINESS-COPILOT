#!/usr/bin/env bun
/**
 * scripts/seed-pricing.ts — Prompt 24 §28/§102/§103.
 *
 * Controlled, IDEMPOTENT pricing seed. The baseline (EUR-v1) is applied by
 * the Prompt 24 migration as well; this script exists to verify/repair the
 * baseline on any environment WITHOUT ever mutating existing amounts.
 *
 * Rules (§28):
 * - create missing PriceBooks / PlanPrices (deterministic ids)
 * - never duplicate (unique constraints + existence checks)
 * - never delete active price history, never overwrite existing amounts
 *   (a mismatch is REPORTED, not "fixed" — a price change is a NEW version)
 * - FREE and ENTERPRISE get no price rows (§38/§39)
 *
 * IRR preparation (§19 option B): the schema + service support IRR, but
 * this script creates an IRR book ONLY when an operator explicitly passes
 * real amounts — invented/placeholder prices are never seeded:
 *
 *   bun scripts/seed-pricing.ts                          # ensure EUR-v1
 *   bun scripts/seed-pricing.ts --list                   # print catalog
 *   bun scripts/seed-pricing.ts --currency IRR \
 *       --monthly STARTER=9900000,BUSINESS=19900000,PRO=49900000 \
 *       --yearly  STARTER=99000000,BUSINESS=199000000,PRO=499000000 \
 *       [--activate]                          # default: created INACTIVE
 *
 * Exit 0 = success (or honest mismatch report), 1 = hard failure.
 */

import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { BASELINE_PRICE_BOOKS, type PriceBookSeed } from "../src/lib/payments/pricing-seed-data";
import { currencyMinorDigits, isSupportedSettlementCurrency } from "../src/lib/payments/currency";

const ROOT = new URL("..", import.meta.url).pathname;

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}

const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

// §63 — validation: positive safe integers, sane ceiling, no zero/negative.
const MAX_AMOUNT_MINOR = 1_000_000_000_000;
function requireSaneAmount(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_MINOR) {
    throw new Error(`${label}: amount must be a positive integer ≤ ${MAX_AMOUNT_MINOR} (got ${value})`);
  }
}

async function ensureBook(seed: PriceBookSeed, activate: boolean): Promise<{ created: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  const existing = await prisma.priceBook.findUnique({
    where: { code_version: { code: seed.code, version: seed.version } },
    include: { prices: true },
  });

  let book = existing;
  if (!book) {
    book = await prisma.priceBook.create({
      data: {
        id: seed.id,
        code: seed.code,
        version: seed.version,
        currency: seed.currency,
        active: activate,
        description: seed.description,
      },
      include: { prices: true },
    });
    console.log(`  + PriceBook ${seed.code} ${seed.version} (${seed.currency}) created (active=${activate})`);
  } else if (book.currency !== seed.currency) {
    throw new Error(`PriceBook ${seed.code}/${seed.version} exists with currency ${book.currency}, expected ${seed.currency}`);
  }

  for (const p of seed.prices) {
    for (const [period, amount] of [
      ["MONTHLY", p.monthlyMinor],
      ["YEARLY", p.yearlyMinor],
    ] as const) {
      requireSaneAmount(`${seed.code}/${p.planCode}/${period}`, amount);
      const row = book.prices.find((r) => r.planCode === p.planCode && r.billingPeriod === period);
      if (!row) {
        await prisma.planPrice.create({
          data: {
            priceBookId: book.id,
            planCode: p.planCode,
            billingPeriod: period,
            amountMinor: amount,
            active: true,
          },
        });
        console.log(`  + PlanPrice ${p.planCode}/${period} = ${amount} ${seed.currency} created`);
      } else if (row.amountMinor !== amount) {
        // §28/§36 — NEVER overwrite. Report and move on.
        mismatches.push(
          `${p.planCode}/${period}: stored ${row.amountMinor} ≠ seed ${amount} (left untouched — create a NEW version instead)`,
        );
      }
    }
  }
  return { created: !existing, mismatches };
}

async function listCatalog(): Promise<void> {
  const books = await prisma.priceBook.findMany({
    orderBy: [{ currency: "asc" }, { effectiveFrom: "desc" }],
    include: { prices: { orderBy: [{ planCode: "asc" }, { billingPeriod: "asc" }] } },
  });
  if (books.length === 0) {
    console.log("(no price books)");
    return;
  }
  for (const b of books) {
    const now = new Date();
    const effective = b.active && b.effectiveFrom <= now && (!b.effectiveTo || b.effectiveTo > now);
    console.log(
      `${b.code} ${b.version} [${b.currency}] active=${b.active} effective=${effective} prices=${b.prices.length}`,
    );
    for (const p of b.prices) {
      console.log(`    ${p.planCode}/${p.billingPeriod} = ${p.amountMinor} (${p.active ? "active" : "retired"})`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    await listCatalog();
    return;
  }

  const irrIndex = args.indexOf("--currency");
  if (irrIndex >= 0) {
    // Explicit IRR (or other currency) book creation — operator-provided
    // amounts only (§19: never invent prices).
    const currency = (args[irrIndex + 1] ?? "").toUpperCase();
    if (!isSupportedSettlementCurrency(currency)) {
      throw new Error(`--currency ${currency}: not a supported settlement currency (EUR/IRR)`);
    }
    const parseAmounts = (flag: string): Map<string, number> => {
      const idx = args.indexOf(flag);
      if (idx < 0) throw new Error(`--${flag} is required for ${currency} (explicit amounts only)`);
      const map = new Map<string, number>();
      for (const pair of (args[idx + 1] ?? "").split(",")) {
        const [plan, raw] = pair.split("=");
        if (!plan || !raw) throw new Error(`--${flag}: expected PLAN=AMOUNT pairs`);
        requireSaneAmount(`${currency}/${plan}`, Number(raw));
        map.set(plan.toUpperCase(), Number(raw));
      }
      return map;
    };
    const monthly = parseAmounts("monthly");
    const yearly = parseAmounts("yearly");
    const plans = [...monthly.keys()];
    if (plans.length === 0 || plans.some((p) => !yearly.has(p))) {
      throw new Error("every plan in --monthly must also appear in --yearly (explicit rows, §61)");
    }
    // Exponent sanity (§22/§23): IRR amounts are whole Rials — nothing to
    // convert; this only documents the unit being stored.
    const digits = currencyMinorDigits(currency);
    console.log(`currency ${currency} minor-unit digits = ${digits} (amounts stored AS-IS in minor units)`);
    const activate = args.includes("--activate");
    const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM
    const seed: PriceBookSeed = {
      id: `pricebook_${currency.toLowerCase()}_operator_${stamp}`,
      code: currency === "IRR" ? "IRR_IRAN" : `${currency}_STANDARD`,
      version: `v1-${stamp}`,
      currency,
      description: `Operator-configured ${currency} catalog (seed-pricing.ts, amounts supplied explicitly).`,
      prices: plans.map((plan) => ({
        planCode: plan as "STARTER" | "BUSINESS" | "PRO",
        monthlyMinor: monthly.get(plan)!,
        yearlyMinor: yearly.get(plan)!,
      })),
    };
    const res = await ensureBook(seed, activate);
    if (!activate) {
      console.log("book created INACTIVE — pass --activate only when this price decision is final (§97)");
    }
    if (res.mismatches.length > 0) {
      console.error("existing amounts differed (left untouched):");
      for (const m of res.mismatches) console.error(`  ! ${m}`);
    }
    return;
  }

  // Default: ensure the baseline EUR-v1 catalog (idempotent).
  let hadMismatch = false;
  for (const seed of BASELINE_PRICE_BOOKS) {
    console.log(`ensuring ${seed.code} ${seed.version} [${seed.currency}]…`);
    const res = await ensureBook(seed, true);
    for (const m of res.mismatches) {
      hadMismatch = true;
      console.error(`  ! ${m}`);
    }
  }
  if (hadMismatch) {
    console.log("seed complete with reported differences — nothing was modified (§28).");
  } else {
    console.log("seed complete: baseline catalog verified/ensured (idempotent).");
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

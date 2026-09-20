"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { formatMoney, type CurrencyConfig } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { BusinessSummary } from "../shell/types";

/**
 * Shared kit for the Phase 03 transaction modules (sales, expenses,
 * payments, receivables, payables) — Rule 04: one implementation,
 * five configurations. All money flows through lib/money (A08).
 */

export const txKeys = {
  sales: ["sales"] as const,
  expenses: ["expenses"] as const,
  payments: ["payments"] as const,
  receivables: ["receivables"] as const,
  payables: ["payables"] as const,
  inventory: ["inventory"] as const,
  products: ["products"] as const,
  audit: ["audit"] as const,
};

/** Invalidate every transaction-derived query after a mutation. */
export function useInvalidateFinance() {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      txKeys.sales,
      txKeys.expenses,
      txKeys.payments,
      txKeys.receivables,
      txKeys.payables,
      txKeys.inventory,
      txKeys.products,
      txKeys.audit,
    ]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
}

export function currencyOf(business: BusinessSummary): CurrencyConfig {
  return {
    currencyCode: business.currencyCode,
    currencySymbol: business.currencySymbol,
    decimalPrecision: business.decimalPrecision,
    locale: business.locale,
  };
}

/** Format minor units with the active business currency config. */
export function fmtMoney(business: BusinessSummary, minor: number): string {
  return formatMoney(minor, currencyOf(business));
}

export function fmtDate(business: BusinessSummary, iso: string): string {
  return new Intl.DateTimeFormat(business.locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
  }).format(new Date(iso));
}

/**
 * Locale-aware count numerals (fa gets ۰۱۲۳…, en gets 0123…). Used for
 * interpolated counts so RTL copy reads natively (A05/A06).
 */
export function fmtCount(uiLocale: string, n: number): string {
  return new Intl.NumberFormat(uiLocale === "fa" ? "fa-IR" : "en-US").format(n);
}

export type TxStatus = "UNPAID" | "PARTIAL" | "PAID";

/** Color-coded payment status badge (single visual language across modules). */
export function FinanceStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const t = useTranslations("finance.status");
  const map: Record<TxStatus, string> = {
    UNPAID: "border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    PARTIAL: "border-sky-300/60 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    PAID: "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  };
  const key = (["UNPAID", "PARTIAL", "PAID"] as const).includes(status as TxStatus)
    ? (status as TxStatus)
    : "UNPAID";
  return (
    <Badge variant="outline" className={cn("font-medium", map[key], className)}>
      {t(key)}
    </Badge>
  );
}

/** Compact stat card used in summary strips (receivables/payables/sales). */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "positive" | "warning";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : "";
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className={cn("mt-1 truncate text-xl font-semibold tabular-nums", toneClass)} dir="ltr">
        {value}
      </p>
      {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}

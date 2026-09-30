"use client";

/**
 * Prompt 33 — shared search UI primitives: closed entity → icon map and
 * localized date formatting. Used by BOTH the command palette results and
 * the Search Results Center so the two surfaces stay visually consistent.
 */
import {
  CreditCard,
  Package,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { SearchEntityType } from "@/lib/search/types";

export const SEARCH_TYPE_ICONS: Record<SearchEntityType, LucideIcon> = {
  CUSTOMER: Users,
  SUPPLIER: Truck,
  PRODUCT: Package,
  SALE: ShoppingCart,
  EXPENSE: Wallet,
  PAYMENT: CreditCard,
};

/** Medium localized date for result rows (never raw ISO in the UI). */
export function formatSearchDate(iso: string, locale: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
      dateStyle: "medium",
    }).format(d);
  } catch {
    return "";
  }
}

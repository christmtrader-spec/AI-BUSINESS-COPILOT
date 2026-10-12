"use client";

/**
 * Prompt 33 — shared search UI primitives: closed entity → icon map and
 * localized date formatting. Used by BOTH the command palette results and
 * the Search Results Center so the two surfaces stay visually consistent.
 */
import {
  ClipboardList,
  FileSignature,
  CreditCard,
  FileText,
  Package,
  PackageCheck,
  PackageMinus,
  PackageOpen,
  ShoppingCart,
  Target,
  TrendingUp,
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
  LEAD: Target,
  OPPORTUNITY: TrendingUp,
  // Prompt 41 (§152) — procurement documents in search results.
  PURCHASE_ORDER: ClipboardList,
  GOODS_RECEIPT: PackageCheck,
  // Prompt 43 (§101) — return documents in search results.
  GOODS_RETURN: PackageMinus,
  // Prompt 44 — outbound dispatch documents in search results.
  GOODS_DISPATCH: PackageOpen,
  // Prompt 45 (§70) — commercial customer orders in search results.
  SALES_ORDER: FileText,
  // Prompt 47 — commercial price offers in search results.
  SALES_QUOTATION: FileSignature,
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

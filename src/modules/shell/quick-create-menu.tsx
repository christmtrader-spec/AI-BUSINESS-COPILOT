"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Banknote, Package, Plus, ReceiptText, Wallet, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import { can, asRole } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BusinessListItem } from "./types";

/**
 * R172 — the global quick-create menu (the header's "+ New").
 * R173 — grew the FOURTH entry: "new-product" joins, closing the R172
 * scope law ("a fourth joins only when its view grows a useQuickIntent
 * hook") — products-view now consumes the intent and opens its REAL
 * create dialog. The dashboard toolbar grew the same fourth tile, so the
 * one law holds: the menu's item set == the dashboard toolbar's tile set.
 *
 * The dashboard's quick-actions toolbar has fired cross-view create intents
 * since Prompt 52 §F2: `fireQuickIntent({action})` + `navigate(module)`, and
 * the target module's `useQuickIntent` hook opens its REAL create dialog
 * (once per intent, the seq guard). This menu lifts that exact mechanism
 * out of the dashboard: the same actions, the same navigation, the
 * same dialogs — reachable from EVERY module instead of home only.
 *
 * Laws carried over, unchanged:
 * - The dashboard toolbar's own gate (`can(asRole(role), "data:write")`)
 *   applies here too — read-only roles see neither entry point.
 * - Item labels reuse the dashboard namespace keys (one source — a second
 *   copy of the same strings would drift; the i18n audit keeps parity).
 * - The trigger carries aria-label AND title from one variable (the R171
 *   title-parity law) and inherits the Button base focus ring.
 * R174 — the items array + tone map are EXPORTED (QUICK_CREATE_ITEMS /
 * QUICK_CREATE_TONES): the ⌘K command palette renders the SAME set from
 * the SAME array, so the family's action set has ONE home.
 */

type QuickCreateAction =
  | "new-sale"
  | "new-payment"
  | "new-expense"
  | "new-product";

export type { QuickCreateAction };

/** R173 — the money trio and the inventory entry are separate groups:
 * a separator renders before the item that starts a new group. */
type QuickCreateItem = {
  action: QuickCreateAction;
  module: "sales" | "payments" | "expenses" | "products";
  labelKey:
    | "quickNewInvoice"
    | "quickRecordPayment"
    | "quickNewExpense"
    | "quickNewProduct";
  icon: LucideIcon;
  startsGroup?: boolean;
  /** R174 — the family's hue, ONE source shared by every surface that
   * renders these actions (the dashboard tiles carry the same hues in
   * their own pinned tile classes). */
  tone: "invoice" | "payment" | "expense" | "product";
};

/** R174 — the tone → icon class map (one hue source for the family;
 * dark variants keep the contrast the tiles already carry). */
export const QUICK_CREATE_TONES: Record<QuickCreateItem["tone"], string> = {
  invoice: "text-emerald-700 dark:text-emerald-400",
  payment: "text-emerald-600 dark:text-emerald-400",
  expense: "text-rose-600 dark:text-rose-400",
  product: "text-sky-600 dark:text-sky-400",
};

/**
 * The ONE source for the quick-create family's action set (R174): the
 * header menu and the ⌘K command palette both render from this array —
 * a second copy of the pairs would drift (the batteries extract the set
 * from every surface and assert equality).
 */
export const QUICK_CREATE_ITEMS: QuickCreateItem[] = [
  { action: "new-sale", module: "sales", labelKey: "quickNewInvoice", icon: ReceiptText, tone: "invoice" },
  { action: "new-payment", module: "payments", labelKey: "quickRecordPayment", icon: Banknote, tone: "payment" },
  { action: "new-expense", module: "expenses", labelKey: "quickNewExpense", icon: Wallet, tone: "expense" },
  { action: "new-product", module: "products", labelKey: "quickNewProduct", icon: Package, tone: "product", startsGroup: true },
];

export function QuickCreateMenu() {
  const tDashboard = useTranslations("dashboard");
  const tShell = useTranslations("shell");
  const fireQuickIntent = useAppStore((s) => s.fireQuickIntent);
  const navigate = useAppStore((s) => s.navigate);
  const activeId = useAppStore((s) => s.activeBusinessId);

  // Same memberships cache the BusinessSwitcher uses (AppRoot warms the key).
  const { data: memberships } = useQuery<BusinessListItem[]>({
    queryKey: ["businesses"],
    queryFn: () => api("/api/v1/businesses", { businessId: null }),
    staleTime: 60_000,
  });
  const list = memberships ?? [];
  const active = list.find((m) => m.business.id === activeId) ?? list[0];
  const writable = active ? can(asRole(active.role), "data:write") : false;

  if (!writable) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2.5"
          aria-label={tShell("quickCreate")}
          title={tShell("quickCreate")}
          data-testid="quick-create"
        >
          <Plus className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{tShell("quickCreateShort")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {QUICK_CREATE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.action} data-testid={`quick-create-group-${item.action}`}>
              {item.startsGroup ? <DropdownMenuSeparator aria-hidden="true" /> : null}
              <DropdownMenuItem
                data-testid={`quick-create-${item.action}`}
                onClick={() => {
                  fireQuickIntent(item.action);
                  navigate({ kind: "module", module: item.module });
                }}
              >
                <Icon
                  className={`size-4 ${QUICK_CREATE_TONES[item.tone]}`}
                  aria-hidden="true"
                />
                {tDashboard(item.labelKey)}
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

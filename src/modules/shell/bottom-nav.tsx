"use client";

import { LayoutDashboard, Menu, ShoppingCart, Warehouse, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore, type AppView } from "@/store/app-store";
import { cn } from "@/lib/utils";
import { prefetchModuleData } from "./prefetch";
import { useSidebar } from "@/components/ui/sidebar";

/**
 * R61 — mobile bottom navigation bar (small screens only, `md:hidden`).
 *
 * Pure navigation chrome: it reuses the app's EXISTING view mechanics —
 * `useAppStore().navigate()` (the exact call the sidebar buttons make,
 * which mirrors the view to the URL hash) and the SidebarProvider's
 * mobile Sheet state (`setOpenMobile(true)`, the same drawer the header
 * hamburger opens) for the "More" item. No new routing, no new state.
 *
 * RTL-safety: items are laid out with flex + logical properties only, so
 * the bar mirrors automatically in the fa (rtl) locale. Icons stack above
 * a tiny label — no directional margins anywhere.
 */

type BottomNavItem = {
  id: "dashboard" | "sales" | "inventory" | "more";
  labelKey: "navDashboard" | "navSales" | "navInventory" | "navMore";
  icon: LucideIcon;
  view?: AppView;
};

const ITEMS: BottomNavItem[] = [
  { id: "dashboard", labelKey: "navDashboard", icon: LayoutDashboard, view: { kind: "dashboard" } },
  { id: "sales", labelKey: "navSales", icon: ShoppingCart, view: { kind: "module", module: "sales" } },
  { id: "inventory", labelKey: "navInventory", icon: Warehouse, view: { kind: "module", module: "inventory" } },
  { id: "more", labelKey: "navMore", icon: Menu },
];

/** Mirrors AppSidebar's module-active logic (kind match, module match). */
function isActive(current: AppView, item: BottomNavItem): boolean {
  if (!item.view) return false;
  if (current.kind === "module" && item.view.kind === "module") {
    return current.module === item.view.module;
  }
  return current.kind === item.view.kind;
}

export function BottomNav() {
  const t = useTranslations("shell");
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();
  // The mobile sidebar is a Sheet whose open state lives in SidebarProvider —
  // the same state the existing header toggle drives on touch devices.
  const { setOpenMobile } = useSidebar();

  const prefetchOnHover = (target: AppView) => {
    const moduleName = target.kind === "module" ? target.module : target.kind === "dashboard" ? "dashboard" : null;
    if (moduleName) prefetchModuleData(queryClient, moduleName);
  };

  return (
    <nav
      aria-label={t("navBarLabel")}
      data-testid="bottom-nav"
      className="bg-background fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="mx-auto flex w-full max-w-lg items-stretch justify-around">
        {ITEMS.map((item) => {
          const active = isActive(view, item);
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`bottomnav-${item.id}`}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                if (item.view) {
                  navigate(item.view);
                } else {
                  // "More" → open the existing Sheet-based mobile sidebar
                  // (same mechanism as the header hamburger on touch layouts).
                  setOpenMobile(true);
                }
              }}
              onMouseEnter={item.view ? () => prefetchOnHover(item.view!) : undefined}
              onFocus={item.view ? () => prefetchOnHover(item.view!) : undefined}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center justify-start gap-0.5 px-1 pt-2 pb-1.5 text-[10px] font-medium transition-colors",
                // R172 — the interaction-state family (the R167-R171 sibling
                // law): a visible keyboard focus ring + reduced-motion pairs.
                // This surface was the LIVE instance of the deep audit's
                // documented cn()-sibling composite blind spot (transition
                // literal and hover state in sibling strings — never scanned
                // as one), so the v1/v2 audits never flagged it.
                "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-md transition-colors motion-reduce:transition-none active:scale-95 motion-reduce:active:scale-100",
                  active && "bg-primary/10",
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="max-w-full truncate leading-none">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

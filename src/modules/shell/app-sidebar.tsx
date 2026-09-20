"use client";

import {
  BarChart3,
  Bot,
  CreditCard,
  HandCoins,
  LayoutDashboard,
  Package,
  ScrollText,
  Settings,
  ShoppingCart,
  Truck,
  UserRound,
  Users,
  Wallet,
  ArrowUpRight,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore, type AppView } from "@/store/app-store";
import { can, asRole, type Role } from "@/lib/rbac";
import { prefetchModuleData } from "./prefetch";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import type { BusinessListItem } from "./types";

type NavItem = {
  view: AppView;
  labelKey:
    | "dashboard"
    | "customers"
    | "suppliers"
    | "products"
    | "inventory"
    | "sales"
    | "expenses"
    | "payments"
    | "receivables"
    | "payables"
    | "copilot"
    | "reports"
    | "audit"
    | "teamMembers"
    | "settings"
    | "profile";
  icon: LucideIcon;
  soon?: boolean;
};

const OVERVIEW: NavItem[] = [
  { view: { kind: "dashboard" }, labelKey: "dashboard", icon: LayoutDashboard },
];

const OPERATIONS: NavItem[] = [
  { view: { kind: "module", module: "customers" }, labelKey: "customers", icon: Users },
  { view: { kind: "module", module: "suppliers" }, labelKey: "suppliers", icon: Truck },
  { view: { kind: "module", module: "products" }, labelKey: "products", icon: Package },
  { view: { kind: "module", module: "inventory" }, labelKey: "inventory", icon: Warehouse },
  { view: { kind: "module", module: "sales" }, labelKey: "sales", icon: ShoppingCart },
  { view: { kind: "module", module: "expenses" }, labelKey: "expenses", icon: Wallet },
  { view: { kind: "module", module: "payments" }, labelKey: "payments", icon: CreditCard },
  { view: { kind: "module", module: "receivables" }, labelKey: "receivables", icon: HandCoins },
  { view: { kind: "module", module: "payables" }, labelKey: "payables", icon: ArrowUpRight },
];

const INTELLIGENCE: NavItem[] = [
  { view: { kind: "module", module: "reports" }, labelKey: "reports", icon: BarChart3 },
  { view: { kind: "module", module: "copilot" }, labelKey: "copilot", icon: Bot },
];

const PLATFORM: NavItem[] = [
  { view: { kind: "audit" }, labelKey: "audit", icon: ScrollText },
  { view: { kind: "settings:members" }, labelKey: "teamMembers", icon: Users },
  { view: { kind: "settings:business" }, labelKey: "settings", icon: Settings },
  { view: { kind: "profile" }, labelKey: "profile", icon: UserRound },
];

function isActive(current: AppView, item: NavItem): boolean {
  if (current.kind === "module" && item.view.kind === "module") {
    return current.module === item.view.module;
  }
  return current.kind === item.view.kind;
}

function viewKey(view: AppView): string {
  return view.kind === "module" ? `module:${view.module}` : view.kind;
}

export function AppSidebar({
  membership,
  side = "left",
}: {
  membership: BusinessListItem | null;
  side?: "left" | "right";
}) {
  const t = useTranslations("nav");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();

  const role = asRole(membership?.role);
  const canSeeAudit = can(role, "audit:read");
  const soonLabel = tCommon("comingSoon");

  /** Hover/focus prefetch — warms heavy queries before the click lands. */
  const prefetchOnHover = (target: AppView) => {
    const moduleName =
      target.kind === "module" ? target.module : target.kind === "dashboard" ? "dashboard" : null;
    if (moduleName) prefetchModuleData(queryClient, moduleName);
  };

  function renderGroup(label: string, items: NavItem[], id: string) {
    const filtered = items.filter((i) => i.view.kind !== "audit" || canSeeAudit);
    if (filtered.length === 0) return null;
    return (
      <SidebarGroup key={id}>
        <SidebarGroupLabel>{label}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {filtered.map((item) => {
              const active = isActive(view, item);
              return (
                <SidebarMenuItem key={viewKey(item.view)}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={t(item.labelKey)}
                    onClick={() => navigate(item.view)}
                    onMouseEnter={() => prefetchOnHover(item.view)}
                    onFocus={() => prefetchOnHover(item.view)}
                    aria-current={active ? "page" : undefined}
                  >
                    <item.icon />
                    <span>{t(item.labelKey)}</span>
                  </SidebarMenuButton>
                  {item.soon ? (
                    <SidebarMenuBadge className="text-muted-foreground group-data-[collapsible=icon]:hidden text-[10px] uppercase tracking-wide">
                      {soonLabel}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <Sidebar collapsible="icon" side={side} data-view="sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="bg-primary/10 flex size-8 shrink-0 items-center justify-center rounded-lg">
                <img src="/logo.svg" alt="" className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <p className="truncate text-sm font-semibold leading-tight">
                  {membership?.business.name ?? "—"}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {membership
                    ? tSettings(`roles.${asRole(membership.role) as Role}` as "OWNER")
                    : ""}
                </p>
              </div>
              {membership?.role === "OWNER" ? (
                <Badge
                  variant="secondary"
                  className="group-data-[collapsible=icon]:hidden shrink-0"
                  title={tSettings("roles.OWNER")}
                >
                  ★
                </Badge>
              ) : null}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {renderGroup(t("sectionOverview"), OVERVIEW, "overview")}
        {renderGroup(t("sectionOperations"), OPERATIONS, "operations")}
        {renderGroup(t("sectionIntelligence"), INTELLIGENCE, "intelligence")}
        {renderGroup(t("sectionPlatform"), PLATFORM, "platform")}
      </SidebarContent>
      <SidebarFooter>
        <div className="text-muted-foreground group-data-[collapsible=icon]:hidden px-3 py-1 text-[11px]">
          Phase 06 · Hardening &amp; polish
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

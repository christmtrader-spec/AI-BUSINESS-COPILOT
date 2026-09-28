"use client";

/**
 * Platform operator shell — Prompt 28 (§15/§16/§17/§87).
 *
 * Sidebar information architecture (§87), permission-gated: sections the
 * operator's role cannot read are NOT rendered (hide, not disable). Uses
 * the same shadcn Sidebar primitives as the tenant shell so EN/FA, RTL/LTR,
 * dark/light, desktop (1280/1440) and mobile (390) behave identically.
 * There is deliberately NO platform navigation inside the tenant sidebar —
 * tenant users never see platform entries (§16); the console is reached by
 * operators directly (deep link / profile entry).
 */
import { lazy, Suspense } from "react";
import { useTranslations } from "next-intl";
import {
  Activity,
  Banknote,
  Bot,
  Building2,
  Gauge,
  LayoutDashboard,
  PanelsTopLeft,
  ScrollText,
  ShieldCheck,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore, type PlatformSection } from "@/store/app-store";
import { dirOf } from "@/i18n/config";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LocaleSwitcher, ThemeToggle } from "@/modules/shell/header";
import type { PlatformSelf } from "./platform-api";

type NavEntry = {
  section: PlatformSection;
  labelKey: string;
  icon: LucideIcon;
  permission: string;
};

/** Hash section id → i18n label key (dash ids map to camelCase keys). */
const SECTION_LABELS: Record<PlatformSection, string> = {
  overview: "sections.overview",
  businesses: "sections.businesses",
  users: "sections.users",
  subscriptions: "sections.subscriptions",
  payments: "sections.payments",
  pricing: "sections.pricing",
  "ai-cost": "sections.aiCost",
  security: "sections.security",
  audit: "sections.audit",
  operators: "sections.operators",
  system: "sections.system",
};

const GROUPS: Array<{ labelKey: string; entries: NavEntry[] }> = [
  { labelKey: "groups.overview", entries: [{ section: "overview", labelKey: "sections.overview", icon: LayoutDashboard, permission: "platform:overview:read" }] },
  {
    labelKey: "groups.business",
    entries: [
      { section: "businesses", labelKey: "sections.businesses", icon: Building2, permission: "platform:businesses:read" },
      { section: "users", labelKey: "sections.users", icon: Users, permission: "platform:users:read" },
    ],
  },
  {
    labelKey: "groups.billing",
    entries: [
      { section: "subscriptions", labelKey: "sections.subscriptions", icon: Wallet, permission: "platform:subscriptions:read" },
      { section: "payments", labelKey: "sections.payments", icon: Banknote, permission: "platform:payments:read" },
      { section: "pricing", labelKey: "sections.pricing", icon: PanelsTopLeft, permission: "platform:pricing:read" },
    ],
  },
  {
    labelKey: "groups.ai",
    entries: [
      { section: "ai-cost", labelKey: "sections.aiCost", icon: Bot, permission: "platform:ai-cost:read" },
    ],
  },
  {
    labelKey: "groups.security",
    entries: [
      { section: "audit", labelKey: "sections.audit", icon: ScrollText, permission: "platform:audit:read" },
      { section: "operators", labelKey: "sections.operators", icon: UsersRound, permission: "platform:operators:read" },
      { section: "security", labelKey: "sections.security", icon: ShieldCheck, permission: "platform:audit:read" },
    ],
  },
  {
    labelKey: "groups.system",
    entries: [{ section: "system", labelKey: "sections.system", icon: Gauge, permission: "platform:system:read" }],
  },
];

export function PlatformShell({
  self,
  section,
}: {
  self: PlatformSelf;
  section: PlatformSection;
}) {
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);
  const locale = useAppStore((s) => s.locale);
  const can = (permission: string) => self.permissions.includes(permission);

  return (
    <SidebarProvider>
      <Sidebar side={dirOf(locale) === "rtl" ? "right" : "left"} collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/15">
              <Activity className="size-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            </div>
            <div className="grid leading-tight group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-semibold">{t("title")}</span>
              <span className="text-muted-foreground text-xs">{t("subtitle")}</span>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {GROUPS.map((group) => {
            const visible = group.entries.filter((e) => can(e.permission));
            if (visible.length === 0) return null;
            return (
              <SidebarGroup key={group.labelKey}>
                <SidebarGroupLabel>{t(group.labelKey as Parameters<typeof t>[0])}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {visible.map((entry) => {
                      const active =
                        section === entry.section ||
                        // security landing highlights audit entries too
                        (entry.section === "audit" && section === "security");
                      return (
                        <SidebarMenuItem key={entry.section}>
                          <SidebarMenuButton
                            isActive={active}
                            aria-current={active ? "page" : undefined}
                            onClick={() => navigate({ kind: "platform", section: entry.section })}
                          >
                            <entry.icon className="size-4" aria-hidden="true" />
                            <span>{t(entry.labelKey as Parameters<typeof t>[0])}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </SidebarContent>
        <SidebarFooter>
          <div className="group-data-[collapsible=icon]:hidden px-2 py-1.5">
            <p className="text-muted-foreground truncate text-xs">
              {t("subtitle")}
            </p>
            <Badge variant="outline" className="mt-1">
              {t(`roles.${self.role}` as Parameters<typeof t>[0])}
            </Badge>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="bg-background/80 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger aria-label={t("toggleSidebar")} />
          <Separator orientation="vertical" className="mr-1 !h-5" />
          <h1 className="text-sm font-semibold">
            {t(SECTION_LABELS[section] as Parameters<typeof t>[0])}
          </h1>
          <div className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={() => navigate({ kind: "dashboard" })}
            >
              {t("backToWorkspace")}
            </Button>
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main id="platform-main" className="flex-1 p-4 md:p-6">
          <PlatformSectionContent section={section} />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}


/**
 * Section content — lazy so a tenant-role probe never downloads platform
 * view code (§16 spirit: no platform API prefetching for non-operators).
 */
const OverviewView = lazy(() => import("./overview-view").then((m) => ({ default: m.OverviewView })));
const BusinessesView = lazy(() => import("./businesses-view").then((m) => ({ default: m.BusinessesView })));
const UsersView = lazy(() => import("./users-view").then((m) => ({ default: m.UsersView })));
const SubscriptionsView = lazy(() => import("./subscriptions-view").then((m) => ({ default: m.SubscriptionsView })));
const PaymentsView = lazy(() => import("./payments-view").then((m) => ({ default: m.PaymentsView })));
const PricingView = lazy(() => import("./pricing-view").then((m) => ({ default: m.PricingView })));
const AiCostView = lazy(() => import("./ai-cost-view").then((m) => ({ default: m.AiCostView })));
const AuditView = lazy(() => import("./audit-view").then((m) => ({ default: m.PlatformAuditView })));
const OperatorsView = lazy(() => import("./operators-view").then((m) => ({ default: m.OperatorsView })));
const SystemView = lazy(() => import("./system-view").then((m) => ({ default: m.SystemView })));

function SectionFallback() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function PlatformSectionContent({ section }: { section: PlatformSection }) {
  switch (section) {
    case "overview":
      return <OverviewView />;
    case "businesses":
      return <BusinessesView />;
    case "users":
      return <UsersView />;
    case "subscriptions":
      return <SubscriptionsView />;
    case "payments":
      return <PaymentsView />;
    case "pricing":
      return <PricingView />;
    case "ai-cost":
      return <AiCostView />;
    case "audit":
    case "security":
      return <AuditView />;
    case "operators":
      return <OperatorsView />;
    case "system":
      return <SystemView />;
    default:
      return <OverviewView />;
  }
}

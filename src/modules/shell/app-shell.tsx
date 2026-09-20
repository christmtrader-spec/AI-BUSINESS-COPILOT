"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api-client";
import { useAppStore, viewKeyOf, type AppView } from "@/store/app-store";
import { asRole, type Role } from "@/lib/rbac";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "./header";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { ModuleBoundary } from "./module-boundary";
import { warmHeavyQueries, onIdle } from "./prefetch";
import type { BusinessListItem } from "./types";
import { DashboardView } from "../dashboard/dashboard-view";
import { PartyView } from "../parties/party-view";
import { ProductsView } from "../products/products-view";
import { InventoryView } from "../inventory/inventory-view";
import { SalesView } from "../sales/sales-view";
import { ExpensesView } from "../expenses/expenses-view";
import { PaymentsView } from "../payments/payments-view";
import { BalancesView } from "../balances/balances-view";
import { ReportsView } from "../reports/reports-view";
import { CopilotView } from "../copilot/copilot-view";
import { BusinessSettingsView } from "../settings/business-settings-view";
import { MembersView } from "../settings/members-view";
import { ProfileView } from "../settings/profile-view";
import { AuditView } from "../audit/audit-view";
import { ComingSoonView } from "./coming-soon-view";

/** Sidebar label key for the current view (used for <title> too). */
function labelKeyOf(view: AppView): string {
  switch (view.kind) {
    case "dashboard":
      return "dashboard";
    case "audit":
      return "audit";
    case "settings:business":
      return "settings";
    case "settings:members":
      return "teamMembers";
    case "profile":
      return "profile";
    case "module": {
      const map: Record<string, string> = {
        customers: "customers",
        suppliers: "suppliers",
        products: "products",
        inventory: "inventory",
        sales: "sales",
        expenses: "expenses",
        payments: "payments",
        receivables: "receivables",
        payables: "payables",
        reports: "reports",
        copilot: "copilot",
      };
      return map[view.module] ?? "dashboard";
    }
    default:
      return "dashboard";
  }
}

export function AppShell({
  memberships,
  dir,
}: {
  memberships: BusinessListItem[];
  dir: "ltr" | "rtl";
}) {
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tBoundary = useTranslations("boundary");
  const tSkip = useTranslations("common");
  const view = useAppStore((s) => s.view);
  const activeId = useAppStore((s) => s.activeBusinessId);
  const navigate = useAppStore((s) => s.navigate);

  const membership =
    memberships.find((m) => m.business.id === activeId) ?? memberships[0] ?? null;
  const role: Role = asRole(membership?.role);

  // Phase 06 — per-module document titles (localized: "Sales · Business · App").
  const moduleLabel = tNav(labelKeyOf(view) as "dashboard");
  useEffect(() => {
    const parts = [
      moduleLabel,
      membership?.business.name,
      tCommon("appName"),
    ].filter(Boolean);
    document.title = parts.join(" · ");
  }, [moduleLabel, membership?.business.name, tCommon]);

  // Phase 06 — idle prefetch warming: reports/summary + balances are the
  // heaviest deterministic queries; warm them once per business so deep
  // links into Reports/Receivables/Payables render from cache instantly.
  const queryClient = useQueryClient();
  const activeBusinessId = membership?.business.id;
  useEffect(() => {
    if (!activeBusinessId) return;
    const cancel = onIdle(() => warmHeavyQueries(queryClient));
    return cancel;
  }, [activeBusinessId, queryClient]);

  const viewKey = viewKeyOf(view);

  return (
    <SidebarProvider>
      <AppSidebar membership={membership} side={dir === "rtl" ? "right" : "left"} />
      <SidebarInset>
        {/* a11y: keyboard users can jump past the navigation chrome */}
        <a
          href="#main-content"
          className="bg-primary text-primary-foreground sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
        >
          {tSkip("skipToContent")}
        </a>
        <AppHeader />
        <main id="main-content" className="flex-1 p-4 sm:p-6">
          <div className="mx-auto w-full max-w-6xl">
            <div key={viewKey} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
              {view.kind === "dashboard" ? <DashboardView membership={membership!} /> : null}
              {view.kind === "settings:business" ? (
                <BusinessSettingsView business={membership!.business} />
              ) : null}
              {view.kind === "settings:members" ? <MembersView membership={membership!} /> : null}
              {view.kind === "profile" ? <ProfileView /> : null}
              {view.kind === "audit" ? <AuditView membership={membership!} /> : null}
              {view.kind === "module" ? (
                <ModuleBoundary
                  moduleKey={viewKey}
                  title={tBoundary("title")}
                  description={tBoundary("description")}
                  retry={tCommon("retry")}
                  dashboardLabel={tNav("dashboard")}
                  onDashboard={() => navigate({ kind: "dashboard" })}
                >
                  {view.module === "customers" ? (
                    <PartyView kind="customer" business={membership!.business} role={role} />
                  ) : view.module === "suppliers" ? (
                    <PartyView kind="supplier" business={membership!.business} role={role} />
                  ) : view.module === "products" ? (
                    <ProductsView business={membership!.business} role={role} />
                  ) : view.module === "inventory" ? (
                    <InventoryView business={membership!.business} role={role} />
                  ) : view.module === "sales" ? (
                    <SalesView business={membership!.business} role={role} />
                  ) : view.module === "expenses" ? (
                    <ExpensesView business={membership!.business} role={role} />
                  ) : view.module === "payments" ? (
                    <PaymentsView business={membership!.business} role={role} />
                  ) : view.module === "receivables" ? (
                    <BalancesView kind="receivables" business={membership!.business} role={role} />
                  ) : view.module === "payables" ? (
                    <BalancesView kind="payables" business={membership!.business} role={role} />
                  ) : view.module === "reports" ? (
                    <ReportsView business={membership!.business} />
                  ) : view.module === "copilot" ? (
                    <CopilotView business={membership!.business} role={role} />
                  ) : (
                    <ComingSoonView module={view.module} />
                  )}
                </ModuleBoundary>
              ) : null}
            </div>
          </div>
        </main>
        <footer className="border-t">
          <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-1 px-4 py-3 text-xs sm:flex-row">
            <p>
              {tCommon("appName")} · Phase 06 · Hardening &amp; polish
            </p>
            <p>© {new Date().getFullYear()} — {tCommon("tagline")}</p>
          </div>
        </footer>
      </SidebarInset>
      <CommandPalette membership={membership} />
    </SidebarProvider>
  );
}

export function useMembershipsQuery(enabled: boolean) {
  return useQuery<BusinessListItem[]>({
    queryKey: ["businesses"],
    queryFn: () => api("/api/v1/businesses", { businessId: null }),
    enabled,
    staleTime: 60_000,
  });
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { asRole, type Role } from "@/lib/rbac";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "./header";
import { AppSidebar } from "./app-sidebar";
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
import { BusinessSettingsView } from "../settings/business-settings-view";
import { MembersView } from "../settings/members-view";
import { ProfileView } from "../settings/profile-view";
import { AuditView } from "../audit/audit-view";
import { ComingSoonView } from "./coming-soon-view";

export function AppShell({
  memberships,
  dir,
}: {
  memberships: BusinessListItem[];
  dir: "ltr" | "rtl";
}) {
  const tCommon = useTranslations("common");
  const view = useAppStore((s) => s.view);
  const activeId = useAppStore((s) => s.activeBusinessId);

  const membership =
    memberships.find((m) => m.business.id === activeId) ?? memberships[0] ?? null;
  const role: Role = asRole(membership?.role);

  return (
    <SidebarProvider>
      <AppSidebar membership={membership} side={dir === "rtl" ? "right" : "left"} />
      <SidebarInset>
        <AppHeader />
        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto w-full max-w-6xl">
            {view.kind === "dashboard" ? <DashboardView membership={membership!} /> : null}
            {view.kind === "settings:business" ? (
              <BusinessSettingsView business={membership!.business} />
            ) : null}
            {view.kind === "settings:members" ? <MembersView membership={membership!} /> : null}
            {view.kind === "profile" ? <ProfileView /> : null}
            {view.kind === "audit" ? <AuditView membership={membership!} /> : null}
            {view.kind === "module" ? (
              view.module === "customers" ? (
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
              ) : (
                <ComingSoonView module={view.module} />
              )
            ) : null}
          </div>
        </main>
        <footer className="border-t">
          <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-1 px-4 py-3 text-xs sm:flex-row">
            <p>
              {tCommon("appName")} · Phase 04 · Reports
            </p>
            <p>© {new Date().getFullYear()} — {tCommon("tagline")}</p>
          </div>
        </footer>
      </SidebarInset>
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

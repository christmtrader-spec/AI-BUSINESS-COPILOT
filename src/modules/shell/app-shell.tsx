"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { SecurityCenterView } from "../settings/security-view";
import { DataPortabilityView } from "../settings/data-portability/data-portability-view";
import { NotificationsPreferencesView } from "../settings/notifications-preferences-view";
import { NotificationsView } from "../notifications/notifications-view";
import { SearchCenterView } from "../search/search-view";
import { EntityDetailView } from "../entities/entity-detail-view";
import { ENTITY_ROUTES } from "@/lib/entity-routes";
import { CrmView } from "../crm/crm-view";
import { SubscriptionView } from "../billing/subscription-view";
import { PaymentReturnView } from "../billing/payment-return-view";
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
    case "settings:billing":
      return "billing";
    case "settings:security":
      return "security";
    case "settings:data":
      return "dataPortability";
    case "notifications":
      return "notifications";
    case "settings:notifications":
      return "notifications";
    // Prompt 33 — Search Results Center document title.
    case "search":
      return "search";
    // Prompt 35 (§36) — CRM module document title.
    case "crm":
      return "crm";
    // Prompt 34 — entity detail titles reuse the owning module's nav label.
    case "entity":
      return ENTITY_ROUTES[view.entity].labelKey;
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

  // Prompt 23 §41 — the provider-callback return page. `?payment_return=<id>`
  // is set by OUR callback API (built from the configured base URL, never a
  // user-supplied URL). The view renders ONLY server-verified state.
  const [paymentReturnSessionId, clearPaymentReturn] = usePaymentReturnSessionId();

  // Dismiss the return view as soon as the user navigates elsewhere.
  // Navigation is compared by VIEW OBJECT IDENTITY, not viewKey: on a fresh
  // `/?payment_return=<id>` load the underlying view is already the default
  // dashboard, so clicking «Dashboard» produces the SAME viewKey and would
  // never dismiss. navigate()/replaceView() always pass a fresh object.
  const prevViewRef = useRef<AppView | null>(null);
  useEffect(() => {
    if (prevViewRef.current === null) {
      prevViewRef.current = view;
      return;
    }
    if (prevViewRef.current !== view) {
      prevViewRef.current = view;
      clearPaymentReturn();
    }
  }, [view, clearPaymentReturn]);

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
          {paymentReturnSessionId ? (
            <div className="mx-auto w-full max-w-6xl">
              <PaymentReturnView
                sessionId={paymentReturnSessionId}
                onDone={clearPaymentReturn}
              />
            </div>
          ) : (
          <div className="mx-auto w-full max-w-6xl">
            <div key={viewKey} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
              {view.kind === "dashboard" ? <DashboardView membership={membership!} /> : null}
              {view.kind === "settings:business" ? (
                <BusinessSettingsView business={membership!.business} />
              ) : null}
              {view.kind === "settings:members" ? <MembersView membership={membership!} /> : null}
              {view.kind === "settings:billing" ? (
                <SubscriptionView business={membership!.business} role={role} />
              ) : null}
              {view.kind === "settings:security" ? <SecurityCenterView /> : null}
              {view.kind === "settings:data" ? <DataPortabilityView role={role} /> : null}
              {view.kind === "notifications" ? <NotificationsView /> : null}
              {view.kind === "settings:notifications" ? <NotificationsPreferencesView /> : null}
              {view.kind === "search" ? <SearchCenterView /> : null}
              {view.kind === "crm" ? (
                <ModuleBoundary
                  moduleKey={viewKey}
                  title={tBoundary("title")}
                  description={tBoundary("description")}
                  retry={tCommon("retry")}
                  dashboardLabel={tNav("dashboard")}
                  onDashboard={() => navigate({ kind: "dashboard" })}
                >
                  <CrmView business={membership!.business} role={role} tab={view.tab} />
                </ModuleBoundary>
              ) : null}
              {view.kind === "entity" ? (
                <ModuleBoundary
                  moduleKey={viewKey}
                  title={tBoundary("title")}
                  description={tBoundary("description")}
                  retry={tCommon("retry")}
                  dashboardLabel={tNav("dashboard")}
                  onDashboard={() => navigate({ kind: "dashboard" })}
                >
                  <EntityDetailView
                    entity={view.entity}
                    id={view.id}
                    business={membership!.business}
                    role={role}
                  />
                </ModuleBoundary>
              ) : null}
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
          )}
        </main>
        <footer className="border-t">
          <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-1 px-4 py-3 text-xs sm:flex-row">
            <p>
              {tCommon("appName")}
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
  const queryClient = useQueryClient();
  return useQuery<BusinessListItem[]>({
    queryKey: ["businesses"],
    queryFn: async () => {
      const res = await fetch("/api/v1/businesses", { credentials: "same-origin" });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* non-JSON */ };
      const err = (body as { error?: { code?: string } } | null)?.error;
      if (!res.ok) {
        // Prompt 30 §83/§229 — a globally invalidated session (password
        // change / MFA enable / admin kill switch) must land the user on
        // the sign-in view, never a permanent splash. Clear the stale
        // cookie client-side; NextAuth's session state flips to signed-out.
        if (res.status === 401 || err?.code === "SESSION_INVALIDATED" || err?.code === "SESSION_REVOKED") {
          queryClient.clear();
          void import("next-auth/react").then((m) => m.signOut({ redirect: false }));
        }
        throw new Error(err?.code ?? `HTTP_${res.status}`);
      }
      return (body as { data: BusinessListItem[] }).data;
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Prompt 23 §41 — reads `?payment_return=<sessionId>` (set ONLY by our own
 * callback API). Value is validated shape-wise (cuid-ish length bound);
 * the session itself is re-authorized server-side, so a forged id simply
 * renders a 404-ish "unknown" state — never another tenant's data.
 * Listens to popstate so browser back/forward and the view's own
 * clear() stay in sync.
 */
function usePaymentReturnSessionId(): [string | null, () => void] {
  const read = () => {
    try {
      const raw = new URLSearchParams(window.location.search).get("payment_return");
      return raw && raw.length >= 20 && raw.length <= 40 && /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
    } catch {
      return null;
    }
  };
  const [sessionId, setSessionId] = useState<string | null>(read);
  useEffect(() => {
    const sync = () => setSessionId(read());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const clear = useCallback(() => {
    // Strip ONLY the ?payment_return query — never touch the hash (the view
    // may be navigating via the app hash-router at the same time).
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    setSessionId(null);
  }, []);
  return [sessionId, clear];
}

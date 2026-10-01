"use client";

/**
 * Prompt 34 — EntityDetailView dispatcher (§23).
 * ONE query per mounted detail (keyed by businessId + entity + id, §35),
 * shared loading/error/not-found states (§49/§79/§80), then dispatch to
 * the per-entity view. Mounted inside the shell's ModuleBoundary.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { asRole, type Role } from "@/lib/rbac";
import { ApiClientError } from "@/lib/api-client";
import type { EntityType } from "@/lib/entity-routes";
import { useAppStore } from "@/store/app-store";
import type { BusinessSummary } from "../shell/types";
import { useEntityQuery } from "./entity-api";
import { navigateToEntityList } from "./entity-route";
import { EntityLoading } from "./entity-loading";
import { EntityError } from "./entity-error";
import { EntityNotFound } from "./entity-not-found";
import { CustomerDetailView } from "./customer-detail-view";
import { SupplierDetailView } from "./supplier-detail-view";
import { ProductDetailView } from "./product-detail-view";
import { SaleDetailView } from "./sale-detail-view";
import { ExpenseDetailView } from "./expense-detail-view";
import { PaymentDetailView } from "./payment-detail-view";
import type {
  CustomerDetail,
  ExpenseDetail,
  PaymentDetail,
  ProductDetail,
  SaleDetail,
  SupplierDetail,
} from "@/lib/entities";

export function EntityDetailView({
  entity,
  id,
  business,
  role: roleProp,
}: {
  entity: EntityType;
  id: string;
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("entityDetail");
  const tNav = useTranslations("nav");
  const queryClient = useQueryClient();
  const activeBusinessId = useAppStore((s) => s.activeBusinessId);
  const uiLocale = useAppStore((s) => s.locale);
  const role = asRole(roleProp);

  // Localized list labels per entity (closed map — no dynamic key casts).
  const listLabel: Record<EntityType, string> = {
    customer: t("customers"),
    supplier: t("suppliers"),
    product: t("products"),
    sale: t("sales"),
    expense: t("expenses"),
    payment: t("payments"),
  };
  const backLabel = t("backTo", { list: listLabel[entity] });

  // §36 — business switch: invalidate the entity domain so no cross-
  // business detail can survive in cache. The query key below also carries
  // the businessId, so the mounted view re-resolves against the new
  // business (404 → shared not-found state).
  useEffect(() => {
    if (!activeBusinessId) return;
    void queryClient.invalidateQueries({ queryKey: ["entities", activeBusinessId] });
  }, [activeBusinessId, queryClient]);

  const query = useEntityQuery<
    CustomerDetail | SupplierDetail | ProductDetail | SaleDetail | ExpenseDetail | PaymentDetail
  >(entity, id);

  const backToList = () => navigateToEntityList(entity);

  if (query.isPending) {
    return <EntityLoading />;
  }

  if (query.isError) {
    // §49 — 404 (unknown/deleted/foreign) gets the shared not-found state;
    // everything else the distinguishing error view.
    if (query.error instanceof ApiClientError && query.error.status === 404) {
      return (
        <EntityNotFound
          backToList={backLabel}
          onBackToList={backToList}
          dashboardLabel={tNav("dashboard")}
          onDashboard={() => useAppStore.getState().navigate({ kind: "dashboard" })}
        />
      );
    }
    return (
      <EntityError
        error={query.error}
        onRetry={() => void query.refetch()}
        backToList={backLabel}
        onBackToList={backToList}
      />
    );
  }

  if (!query.data) {
    return (
      <EntityNotFound
        backToList={backLabel}
        onBackToList={backToList}
        dashboardLabel={tNav("dashboard")}
        onDashboard={() => useAppStore.getState().navigate({ kind: "dashboard" })}
      />
    );
  }

  switch (entity) {
    case "customer":
      return (
        <CustomerDetailView
          data={query.data as CustomerDetail}
          business={business}
          uiLocale={uiLocale}
          role={role}
        />
      );
    case "supplier":
      return (
        <SupplierDetailView
          data={query.data as SupplierDetail}
          business={business}
          uiLocale={uiLocale}
          role={role}
        />
      );
    case "product":
      return (
        <ProductDetailView
          data={query.data as ProductDetail}
          business={business}
          uiLocale={uiLocale}
          role={role}
        />
      );
    case "sale":
      return (
        <SaleDetailView
          data={query.data as SaleDetail}
          business={business}
          uiLocale={uiLocale}
          role={role}
        />
      );
    case "expense":
      return (
        <ExpenseDetailView
          data={query.data as ExpenseDetail}
          business={business}
          role={role}
        />
      );
    case "payment":
      return (
        <PaymentDetailView
          data={query.data as PaymentDetail}
          business={business}
          role={role}
        />
      );
    default: {
      // Exhaustiveness guard — the closed vocabulary makes this unreachable.
      return (
        <EntityNotFound
          backToList={backLabel}
          onBackToList={backToList}
          dashboardLabel={tNav("dashboard")}
          onDashboard={() => useAppStore.getState().navigate({ kind: "dashboard" })}
        />
      );
    }
  }
}

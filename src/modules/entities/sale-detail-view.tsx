"use client";

/**
 * Prompt 34 — Sale (invoice) detail page (§28).
 * Invoice header + totals + items table (product rows navigate to the
 * product detail) + payments list (rows navigate to payment detail).
 * Read-only surface: VIEW never mutates (§65); the existing list dialog
 * remains the print/quick-pay surface.
 */

import { useTranslations } from "next-intl";
import { CalendarDays, CreditCard, ShoppingCart, UserRound } from "lucide-react";
import { formatInvoiceNumber } from "@/lib/finance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, Ltr, type ColumnDef } from "@/components/shared/data-table";
import {
  FinanceStatusBadge,
  fmtDate,
  fmtMoney,
} from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { RelatedRecordList } from "./related-record-list";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import type { SaleDetail, SaleItemLine } from "@/lib/entities";

export function SaleDetailView({
  data,
  business,
  uiLocale,
}: {
  data: SaleDetail;
  business: BusinessSummary;
  uiLocale: string;
}) {
  const t = useTranslations("entityDetail");
  const tSearch = useTranslations("search");
  const s = data.sale;

  const columns: ColumnDef<SaleItemLine>[] = [
    {
      id: "product",
      header: t("product"),
      cell: (item) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium" dir="auto">
            {item.name}
          </span>
          {item.unit ? (
            <span className="text-muted-foreground text-xs">{item.unit}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: "qty",
      header: t("qty"),
      align: "end",
      cell: (item) => (
        <Ltr className="tabular-nums">{item.qty}</Ltr>
      ),
    },
    {
      id: "unitPrice",
      header: t("unitPrice"),
      align: "end",
      hideBelow: "sm",
      cell: (item) => <Ltr>{fmtMoney(business, item.unitPriceMinor)}</Ltr>,
    },
    {
      id: "lineTotal",
      header: t("lineTotal"),
      align: "end",
      cell: (item) => <Ltr className="font-medium">{fmtMoney(business, item.lineTotalMinor)}</Ltr>,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("sales")} title={`INV-${String(s.number).padStart(4, "0")}`} />
        <EntityHeader
          icon={ShoppingCart}
          title={formatInvoiceNumber(s.number)}
          subtitle={
            s.customerName
              ? s.customerName
              : t("walkIn")
          }
          badge={<FinanceStatusBadge status={s.status} />}
          backLabel={t("backTo", { list: t("sales") })}
          onBack={() => navigateToEntityList("sale")}
          actions={
            s.customerId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigateToEntity("customer", s.customerId as string)}
              >
                <UserRound className="size-4" aria-hidden="true" />
                {t("openCustomer")}
              </Button>
            ) : null
          }
        />
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          {fmtDate(business, s.issueDate)}
        </p>
      </div>

      {/* Totals (§28) — integer minor units through the money utils (§43) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <EntityMetricCard
          label={t("subtotal")}
          value={fmtMoney(business, s.subtotalMinor)}
        />
        <EntityMetricCard
          label={t("discount")}
          value={fmtMoney(business, s.discountMinor)}
        />
        <EntityMetricCard label={t("total")} value={fmtMoney(business, s.totalMinor)} />
        <EntityMetricCard
          label={t("paid")}
          value={fmtMoney(business, s.paidMinor)}
          tone="positive"
        />
        <EntityMetricCard
          label={t("balance")}
          value={fmtMoney(business, s.balanceMinor)}
          tone={s.balanceMinor > 0 ? "warning" : "positive"}
        />
      </div>

      {s.note ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("note")}
            </p>
            <p className="mt-1 text-sm break-words" dir="auto">
              {s.note}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Items (§28): product rows open the product detail (tenant-safe) */}
      <section aria-label={t("items")} className="bg-card overflow-hidden rounded-xl border">
        <h2 className="text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
          <ShoppingCart className="size-4" aria-hidden="true" />
          {t("items")}
          <Badge variant="secondary" className="ms-auto">
            {uiLocale === "fa" ? data.items.length.toLocaleString("fa-IR") : data.items.length}
          </Badge>
        </h2>
        <DataTable<SaleItemLine>
          columns={columns}
          rows={data.items}
          getRowId={(i) => i.id}
          ariaLabel={t("items")}
          sortLocale={business.locale}
          containerClassName="rounded-none border-0 shadow-none"
          onRowClick={
            data.items.some((i) => i.productId)
              ? (item) => {
                  if (item.productId) navigateToEntity("product", item.productId);
                }
              : undefined
          }
        />
      </section>

      {/* Payments (§28): rows open the payment detail */}
      <RelatedRecordList
        title={t("payments")}
        entity="payment"
        emptyText={t("noPayments")}
        onOpen={navigateToEntity}
        items={data.payments.map((p) => ({
          id: p.id,
          icon: CreditCard,
          primary: tSearch(`method.${p.method}`),
          secondary: p.actorName ? t("recordedBy", { name: p.actorName }) : p.note,
          trailing: fmtMoney(business, p.amountMinor),
          trailingMuted: fmtDate(business, p.paidAt),
        }))}
      />
    </div>
  );
}

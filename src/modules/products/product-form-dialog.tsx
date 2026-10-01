"use client";

/**
 * Prompt 34 — product form dialog, EXTRACTED from products-view so the
 * Products list and the product DETAIL page share ONE create/edit form
 * (§27/§75). Behavior is identical; onSuccess also invalidates the affected
 * product detail (§37, targeted).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import { api, ApiClientError } from "@/lib/api-client";
import { fromMinor } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormDialog, MoneyInput, moneyToMinorOrNull } from "@/components/shared/table-kit";
import { useAppStore } from "@/store/app-store";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import type { Product } from "./products-view";

type ProductForm = {
  name: string;
  sku: string;
  unit: string;
  salePrice: string;
  costPrice: string;
  stockQty: string;
  lowStockAt: string;
};

function formFrom(p: Product | null, precision: number): ProductForm {
  return p
    ? {
        name: p.name,
        sku: p.sku ?? "",
        unit: p.unit ?? "",
        salePrice: String(fromMinor(p.salePriceMinor, precision)),
        costPrice: String(fromMinor(p.costPriceMinor, precision)),
        stockQty: String(p.stockQty),
        lowStockAt: String(p.lowStockAt),
      }
    : { name: "", sku: "", unit: "", salePrice: "", costPrice: "", stockQty: "0", lowStockAt: "5" };
}

export function ProductFormDialog({
  open,
  onOpenChange,
  editing,
  business,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Product | null;
  business: { currencySymbol: string; decimalPrecision: number };
}) {
  const t = useTranslations("products");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const precision = business.decimalPrecision;

  const [form, setForm] = useState<ProductForm>(() => formFrom(editing, precision));

  // Render-phase reset when the dialog opens (React-sanctioned adjustment).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setForm(formFrom(editing, precision));
  }

  const saleMinor = moneyToMinorOrNull(form.salePrice, precision);
  const costMinor = moneyToMinorOrNull(form.costPrice, precision);
  const stockQty = Number.parseInt(form.stockQty || "0", 10);
  const lowStockAt = Number.parseInt(form.lowStockAt || "5", 10);
  const formValid =
    form.name.trim() !== "" &&
    saleMinor !== null &&
    costMinor !== null &&
    Number.isInteger(stockQty) &&
    stockQty >= 0 &&
    Number.isInteger(lowStockAt) &&
    lowStockAt >= 0;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({
        name: form.name,
        sku: form.sku || null,
        unit: form.unit || null,
        salePriceMinor: saleMinor ?? 0,
        costPriceMinor: costMinor ?? 0,
        ...(editing ? { lowStockAt } : { stockQty: Number.isInteger(stockQty) ? stockQty : 0, lowStockAt }),
      });
      return editing
        ? api(`/api/v1/products/${editing.id}`, { method: "PATCH", body })
        : api("/api/v1/products", { method: "POST", body });
    },
    onSuccess: () => {
      toast({ title: editing ? t("updatedToast") : t("createdToast") });
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["adjustments"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      // §37 — the open product detail (if any) converges to server state.
      if (editing) invalidateEntityDetail(queryClient, businessId, "product", editing.id);
    },
    onError: (err) => {
      toast({
        title: billingErrorText(err) || (err instanceof ApiClientError ? err.message : tErrors("generic")),
        variant: "destructive",
      });
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("edit") : t("add")}
      description={t("formDescription")}
      submitLabel={editing ? tCommon("save") : tCommon("add")}
      cancelLabel={tCommon("cancel")}
      pending={saveMutation.isPending}
      disabled={!formValid}
      onSubmit={(e) => {
        e.preventDefault();
        if (formValid) saveMutation.mutate();
      }}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="pr-name">{t("name")}</Label>
          <Input
            id="pr-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("namePlaceholder")}
            maxLength={160}
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="pr-sku">{t("sku")}</Label>
            <Input
              id="pr-sku"
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
              dir="ltr"
              maxLength={60}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pr-unit">{t("unit")}</Label>
            <Input
              id="pr-unit"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              placeholder={t("unitPlaceholder")}
              maxLength={20}
            />
          </div>
          <MoneyInput
            id="pr-sale"
            label={t("salePrice")}
            symbol={business.currencySymbol}
            value={form.salePrice}
            onChange={(v) => setForm({ ...form, salePrice: v })}
            precision={precision}
            invalidMsg={t("invalidMoney")}
          />
          <MoneyInput
            id="pr-cost"
            label={t("costPrice")}
            symbol={business.currencySymbol}
            value={form.costPrice}
            onChange={(v) => setForm({ ...form, costPrice: v })}
            precision={precision}
            invalidMsg={t("invalidMoney")}
          />
          {!editing ? (
            <div className="space-y-2">
              <Label htmlFor="pr-stock">{t("initialStock")}</Label>
              <Input
                id="pr-stock"
                value={form.stockQty}
                onChange={(e) => setForm({ ...form, stockQty: e.target.value })}
                dir="ltr"
                inputMode="numeric"
                className="text-end"
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="pr-low">{t("lowStockAt")}</Label>
            <Input
              id="pr-low"
              value={form.lowStockAt}
              onChange={(e) => setForm({ ...form, lowStockAt: e.target.value })}
              dir="ltr"
              inputMode="numeric"
              className="text-end"
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{t("priceNote")}</p>
      </div>
    </FormDialog>
  );
}

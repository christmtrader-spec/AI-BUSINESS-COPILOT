"use client";

/**
 * Prompt 40 — bounded product selector (§62/§63).
 * Uses the EXISTING products API (server-side name/SKU search, page size 10,
 * no full product download — §246). Shows name + SKU + current stock only
 * (no cost/sale price). Adding is a stocktake DRAFT mutation done by the
 * parent view; this component only selects.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, Plus } from "lucide-react";
import { inventoryKeys, fetchProductOptions } from "./stocktake-api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function StocktakeProductPicker({
  businessId,
  onPick,
}: {
  businessId: string;
  onPick: (product: { id: string; name: string; stockQty: number }) => void;
}) {
  const t = useTranslations("inventory.stocktakes");
  const tCommon = useTranslations("common");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const products = useQuery({
    queryKey: ["products", "picker", q, page],
    queryFn: () => fetchProductOptions(businessId, q, page),
    staleTime: 10_000,
  });

  const items = products.data?.items ?? [];
  const total = products.data?.total ?? 0;
  const pageSize = products.data?.pageSize ?? 10;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
        placeholder={tCommon("search")}
        aria-label={t("addProductSearch")}
      />
      <div className="max-h-64 overflow-y-auto rounded-lg border" role="list" aria-label={t("addProductSearch")}>
        {products.isLoading ? (
          <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("noProductsFound")}</p>
        ) : (
          items.map((p) => (
            <div
              key={p.id}
              role="listitem"
              className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" dir="auto">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground" dir="ltr">
                  {p.sku ?? "—"} · {t("currentStock")}: {p.stockQty}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onPick({ id: p.id, name: p.name, stockQty: p.stockQty })}
                aria-label={`${t("addProduct")}: ${p.name}`}
                className="min-h-8"
              >
                <Plus className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only sm:ms-1">{t("addProduct")}</span>
              </Button>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span aria-live="polite">
          {total > 0 ? `${Math.min((page - 1) * pageSize + 1, total)}–${Math.min(page * pageSize, total)} · ${total}` : "0"}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((v) => Math.max(1, v - 1))}
          >
            {tCommon("previous")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={page >= pageCount}
            onClick={() => setPage((v) => Math.min(pageCount, v + 1))}
          >
            {tCommon("next")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PickerDivider() {
  return <div className={cn("border-t my-2")} aria-hidden />;
}

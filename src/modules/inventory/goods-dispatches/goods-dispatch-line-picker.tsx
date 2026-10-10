"use client";

/**
 * Prompt 44 — goods-dispatch LINE picker.
 *
 * A PRODUCT picker (the product IS the outbound source): the list shows
 * active products with their CURRENT stock (fetched over the EXISTING
 * bounded products API). Display is product name/SKU/unit + current
 * stock — NO price anywhere. Products already on the draft dispatch are
 * disabled. Zero-stock products stay selectable (the line-add/post law
 * still governs) but visually flagged.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GoodsDispatchDetailDto } from "@/lib/inventory/goods-dispatch/dto";

type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
  isActive: boolean;
};

export function GoodsDispatchLinePicker({
  businessId,
  existingLines,
  onPick,
  onClose,
}: {
  businessId: string;
  existingLines: GoodsDispatchDetailDto["lines"];
  onPick: (product: ProductOption) => void;
  onClose: () => void;
}) {
  const t = useTranslations("goodsDispatches");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const products = useQuery({
    queryKey: ["goods-dispatches", "product-options", businessId, q, page],
    queryFn: () =>
      api<{ items: ProductOption[]; total: number; page: number; pageSize: number }>(
        `/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`,
      ),
    staleTime: 5_000,
  });

  const existing = useMemo(
    () => new Set(existingLines.map((l) => l.productId)),
    [existingLines],
  );
  const items = products.data?.items ?? [];
  const hasMore = products.data ? page * (products.data.pageSize ?? 10) < products.data.total : false;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg" data-testid="goods-dispatch-line-picker">
        <DialogHeader>
          <DialogTitle>{t("addLineTitle")}</DialogTitle>
          <DialogDescription>{t("addLineSearch")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="gds-line-search">{t("searchLabel")}</Label>
            <Input
              id="gds-line-search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              autoComplete="off"
            />
          </div>

          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border p-2" role="listbox" aria-label={t("addLineTitle")}>
            {products.isLoading ? (
              <p className="text-muted-foreground py-6 text-center text-sm">…</p>
            ) : items.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">{t("noLinesFound")}</p>
            ) : (
              items.map((product) => {
                const alreadyOnDispatch = existing.has(product.id);
                return (
                  <button
                    key={product.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-disabled={alreadyOnDispatch}
                    disabled={alreadyOnDispatch}
                    className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-start text-sm transition-colors enabled:hover:bg-muted/60 disabled:opacity-45"
                    onClick={() => !alreadyOnDispatch && onPick(product)}
                  >
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {product.name}
                      {product.sku ? (
                        <span className="text-muted-foreground font-normal"> · {product.sku}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground flex items-center gap-3 text-xs tabular-nums" dir="ltr">
                      <span className="font-medium">
                        {t("currentStock")}: {product.stockQty}
                      </span>
                      {alreadyOnDispatch ? <span className="text-xs">· {t("duplicateLine")}</span> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {items.length > 0 ? (
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!hasMore}
                onClick={() => setPage((p) => p + 1)}
              >
                ›
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

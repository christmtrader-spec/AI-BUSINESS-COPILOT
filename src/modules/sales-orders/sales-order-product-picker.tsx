"use client";

/**
 * Prompt 45 — sales-order product picker (§76).
 *
 * Server-side bounded Product search (pageSize 10; name/SKU only; never
 * the whole catalogue). ONLY active products appear for new lines (§20).
 * NO stock requirement exists on an ORDER (§29 — no reservation; stock
 * may change before dispatch) — the picker shows the current price as a
 * hint for the agreed price default (§21). Products already on the draft
 * order are disabled (§19 — one line per product).
 */
import { useState } from "react";
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

type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  salePriceMinor: number;
  isActive: boolean;
};

export function SalesOrderProductPicker({
  businessId,
  existingProductIds,
  formatPrice,
  onPick,
  onClose,
}: {
  businessId: string;
  existingProductIds: ReadonlySet<string>;
  /** r56 — currency-aware price formatter from the parent; falls back to
   *  grouped integers (legacy display) when not provided. */
  formatPrice?: (minor: number) => string;
  onPick: (product: ProductOption) => void;
  onClose: () => void;
}) {
  const t = useTranslations("salesOrders");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const products = useQuery({
    queryKey: ["sales-orders", "product-options", businessId, q, page],
    queryFn: () =>
      api<{ items: ProductOption[]; total: number; page: number; pageSize: number }>(
        `/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`,
      ),
    staleTime: 5_000,
  });

  const items = products.data?.items ?? [];
  const hasMore = products.data ? page * (products.data.pageSize ?? 10) < products.data.total : false;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg" data-testid="sales-order-product-picker">
        <DialogHeader>
          <DialogTitle>{t("addLineTitle")}</DialogTitle>
          <DialogDescription>{t("addLineSearch")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="so-line-search">{t("searchLabel")}</Label>
            <Input
              id="so-line-search"
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
                const alreadyOnOrder = existingProductIds.has(product.id);
                return (
                  <button
                    key={product.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-disabled={alreadyOnOrder}
                    disabled={alreadyOnOrder}
                    className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-start text-sm transition-colors enabled:hover:bg-muted/60 disabled:opacity-45 motion-reduce:transition-none"
                    onClick={() => !alreadyOnOrder && onPick(product)}
                  >
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {product.name}
                      {product.sku ? (
                        <span className="text-muted-foreground font-normal"> · {product.sku}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground flex items-center gap-3 text-xs tabular-nums" dir="ltr">
                      <span className="font-medium">
                        {t("unitPrice")}: {formatPrice ? formatPrice(product.salePriceMinor) : product.salePriceMinor.toLocaleString("en-US")}
                      </span>
                      {alreadyOnOrder ? <span className="text-xs">· {t("duplicateProduct")}</span> : null}
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

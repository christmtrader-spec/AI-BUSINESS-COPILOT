"use client";

/**
 * Prompt 41 — bounded supplier selector for purchase-order creation (§77).
 * Uses the EXISTING suppliers API (server-side name/phone/email search,
 * page size 10 — soft-deleted suppliers are already excluded server-side).
 * Keyboard accessible; live region for the page window; no full download.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchSupplierOptions } from "./purchase-orders-api";

export function PurchaseOrderSupplierPicker({
  businessId,
  selectedId,
  onSelect,
}: {
  businessId: string;
  selectedId: string | null;
  onSelect: (supplier: { id: string; name: string }) => void;
}) {
  const t = useTranslations("purchaseOrders");
  const tCommon = useTranslations("common");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const suppliers = useQuery({
    queryKey: ["suppliers", "po-picker", q, page],
    queryFn: () => fetchSupplierOptions(businessId, q, page),
    staleTime: 10_000,
  });

  const items = suppliers.data?.items ?? [];
  const total = suppliers.data?.total ?? 0;
  const pageSize = suppliers.data?.pageSize ?? 10;
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
        aria-label={t("supplierSearch")}
      />
      <div className="max-h-56 overflow-y-auto rounded-lg border" role="listbox" aria-label={t("supplier")}>
        {suppliers.isLoading ? (
          <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("noSuppliersFound")}</p>
        ) : (
          items.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={selectedId === s.id}
              className={cn(
                "flex w-full items-center justify-between gap-3 border-b px-3 py-2.5 text-start text-sm transition-colors last:border-b-0 hover:bg-muted/40",
                selectedId === s.id && "bg-muted/60",
              )}
              onClick={() => onSelect({ id: s.id, name: s.name })}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium" dir="auto">{s.name}</span>
                {s.phone || s.email ? (
                  <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                    {s.phone ?? s.email}
                  </span>
                ) : null}
              </span>
              {selectedId === s.id ? (
                <span className="text-xs font-medium text-primary">{t("selected")}</span>
              ) : null}
            </button>
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

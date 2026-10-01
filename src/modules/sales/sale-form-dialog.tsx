"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { toMinor } from "@/lib/money";
import { MoneyInput, moneyToMinorOrNull } from "@/components/shared/table-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { fmtMoney, useInvalidateFinance } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

type ProductOption = {
  id: string;
  name: string;
  unit: string | null;
  salePriceMinor: number;
  stockQty: number;
};

type LineDraft = {
  key: number;
  productId: string; // "" = custom line
  name: string;
  unit: string | null;
  qty: string;
  unitPrice: string;
};

let lineKeySeq = 1;
function newLine(): LineDraft {
  return { key: lineKeySeq++, productId: "", name: "", unit: null, qty: "1", unitPrice: "" };
}

// Radix Select forbids empty-string item values — sentinels map to "".
const NONE = "__none__";
const CUSTOM = "__custom__";

/**
 * Create-invoice dialog. Line totals and the grand total are computed with
 * integer math (toMinor per row) and RECOMPUTED server-side — the client
 * preview is presentational only (A08).
 */
export function SaleFormDialog({
  open,
  onOpenChange,
  business,
  onCreated,
  presetCustomer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  business: BusinessSummary;
  onCreated?: () => void;
  /** Pre-selected customer — e.g. "New invoice" from the customer 360 page. */
  presetCustomer?: { id: string; name: string } | null;
}) {
  const t = useTranslations("finance.saleForm");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const invalidate = useInvalidateFinance();

  const [customerId, setCustomerId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [discount, setDiscount] = useState("0");
  const [note, setNote] = useState("");

  const { data: products } = useQuery<ProductOption[]>({
    queryKey: ["products", "options"],
    queryFn: async () => {
      const res = await api<{ items: ProductOption[] }>("/api/v1/products?pageSize=100");
      return res.items.filter((p) => p.stockQty >= 0);
    },
    enabled: open,
    staleTime: 15_000,
  });

  const { data: customers } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["customers", "options"],
    queryFn: async () => {
      const res = await api<{ items: { id: string; name: string }[] }>(
        "/api/v1/customers?pageSize=100",
      );
      return res.items;
    },
    enabled: open,
    staleTime: 15_000,
  });

  // The preset customer may live beyond the first options page — merge it
  // into the selectable list so the Select always renders its name.
  const customerOptions = useMemo(() => {
    const list = customers ?? [];
    if (presetCustomer && !list.some((c) => c.id === presetCustomer.id)) {
      return [{ id: presetCustomer.id, name: presetCustomer.name }, ...list];
    }
    return list;
  }, [customers, presetCustomer]);

  const precision = business.decimalPrecision;

  const parsed = useMemo(() => {
    const rows = lines.map((l) => {
      const qty = /^\d+$/.test(l.qty.trim()) ? Number(l.qty.trim()) : null;
      const unitPriceMinor = moneyToMinorOrNull(l.unitPrice, precision);
      const nameOk = l.productId !== "" || l.name.trim().length > 0;
      const valid =
        nameOk && qty !== null && qty >= 1 && unitPriceMinor !== null && unitPriceMinor >= 0;
      const lineTotalMinor = valid ? qty! * unitPriceMinor! : null;
      return { key: l.key, qty, unitPriceMinor, valid, lineTotalMinor };
    });
    const allValid = rows.length > 0 && rows.every((r) => r.valid);
    const subtotalMinor = rows.reduce<number>(
      (acc, r) => acc + (r.lineTotalMinor ?? 0),
      0,
    );
    const discountMinor = moneyToMinorOrNull(discount === "" ? "0" : discount, precision) ?? -1;
    const discountValid = discountMinor >= 0 && discountMinor <= subtotalMinor;
    const totalMinor = discountValid ? subtotalMinor - discountMinor : null;
    return { rows, allValid, subtotalMinor, discountMinor, discountValid, totalMinor };
  }, [lines, discount, precision]);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({
        customerId: customerId || null,
        items: lines.map((l) => ({
          productId: l.productId || null,
          name: l.productId ? (products?.find((p) => p.id === l.productId)?.name ?? l.name) : l.name,
          unit: l.unit,
          qty: Number(l.qty.trim()),
          unitPriceMinor: moneyToMinorOrNull(l.unitPrice, precision)!,
        })),
        discountMinor: moneyToMinorOrNull(discount === "" ? "0" : discount, precision) ?? 0,
        note: note || null,
      });
      return api("/api/v1/sales", { method: "POST", body });
    },
    onSuccess: () => {
      toast({ title: t("savedToast") });
      onOpenChange(false);
      setLines([newLine()]);
      setDiscount("0");
      setNote("");
      setCustomerId("");
      invalidate();
      onCreated?.();
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const canSubmit =
    parsed.allValid && parsed.discountValid && parsed.totalMinor !== null && !mutation.isPending;

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickProduct(key: number, productId: string) {
    const p = products?.find((x) => x.id === productId);
    if (!p) {
      updateLine(key, { productId: "", name: "", unit: null });
      return;
    }
    const major = p.salePriceMinor / 10 ** precision;
    updateLine(key, {
      productId,
      name: p.name,
      unit: p.unit,
      unitPrice: String(major),
    });
  }

  // Reset the draft each time the dialog opens (render-adjust pattern),
  // seeding the pre-selected customer when provided (customer 360 quick action).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setLines([newLine()]);
      setDiscount("0");
      setNote("");
      setCustomerId(presetCustomer?.id ?? "");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="sale-customer">
              {t("customer")} <span className="text-muted-foreground">({tCommon("optional")})</span>
            </Label>
            <Select value={customerId || NONE} onValueChange={(v) => setCustomerId(v === NONE ? "" : v)}>
              <SelectTrigger id="sale-customer" className="w-full">
                <SelectValue placeholder={t("customerPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("walkIn")}</SelectItem>
                {(customerOptions).map((c) => (
                  <SelectItem key={c.id} value={c.id} dir="auto">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("items")}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setLines((prev) => [...prev, newLine()])}
                disabled={lines.length >= 20}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t("addLine")}
              </Button>
            </div>

            <div className="hidden text-muted-foreground gap-2 px-1 text-xs sm:grid sm:grid-cols-[minmax(0,1fr)_4.5rem_7.5rem_7.5rem_2rem]">
              <span>{t("colItem")}</span>
              <span>{t("colQty")}</span>
              <span>{t("colUnitPrice")}</span>
              <span>{t("colLineTotal")}</span>
              <span />
            </div>

            <div className="space-y-2">
              {lines.map((l, idx) => {
                const row = parsed.rows[idx];
                return (
                  <div
                    key={l.key}
                    className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_4.5rem_7.5rem_7.5rem_2rem] sm:items-start sm:border-0 sm:p-0"
                  >
                    <div className="space-y-1.5">
                      <Select
                        value={l.productId || CUSTOM}
                        onValueChange={(v) => pickProduct(l.key, v === CUSTOM ? "" : v)}
                      >
                        <SelectTrigger className="h-9 w-full" aria-label={t("colItem")}>
                          <SelectValue placeholder={t("pickProduct")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={CUSTOM} dir="auto">
                            {t("customItem")}
                          </SelectItem>
                          {(products ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.id} dir="auto">
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {l.productId === "" ? (
                        <Input
                          value={l.name}
                          onChange={(e) => updateLine(l.key, { name: e.target.value })}
                          placeholder={t("itemNamePlaceholder")}
                          maxLength={160}
                          className="h-9"
                          dir="auto"
                        />
                      ) : null}
                    </div>
                    <Input
                      value={l.qty}
                      onChange={(e) => updateLine(l.key, { qty: e.target.value })}
                      inputMode="numeric"
                      className="h-9"
                      aria-label={t("colQty")}
                      dir="ltr"
                    />
                    <MoneyInputMini
                      id={`price-${l.key}`}
                      symbol={business.currencySymbol}
                      value={l.unitPrice}
                      onChange={(v) => updateLine(l.key, { unitPrice: v })}
                      label={t("colUnitPrice")}
                      precision={precision}
                    />
                    <div className="flex items-center justify-between gap-2 sm:justify-start">
                      <span
                        className={`text-sm font-medium tabular-nums sm:mt-2 ${
                          row?.lineTotalMinor == null ? "text-muted-foreground" : ""
                        }`}
                        dir="ltr"
                      >
                        {row?.lineTotalMinor != null
                          ? fmtMoney(business, row.lineTotalMinor)
                          : "—"}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive size-8 sm:hidden"
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        aria-label={tCommon("delete")}
                        disabled={lines.length <= 1}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive mt-2 hidden size-8 sm:block"
                      onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                      aria-label={tCommon("delete")}
                      disabled={lines.length <= 1}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyInput
              id="sale-discount"
              label={t("discount")}
              symbol={business.currencySymbol}
              value={discount}
              precision={precision}
              onChange={setDiscount}
              invalidMsg={t("invalidDiscount")}
            />
            <div className="space-y-2">
              <Label htmlFor="sale-note">
                {t("note")} <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Textarea
                id="sale-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={1000}
              />
            </div>
          </div>

          <Separator />
          <div className="space-y-1 text-sm tabular-nums" dir="ltr">
            <div className="text-muted-foreground flex justify-between">
              <span>{t("subtotal")}</span>
              <span>{fmtMoney(business, parsed.subtotalMinor)}</span>
            </div>
            <div className="text-muted-foreground flex justify-between">
              <span>{t("discount")}</span>
              <span>−{fmtMoney(business, Math.max(parsed.discountMinor, 0))}</span>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <span>{t("total")}</span>
              <span>{parsed.totalMinor != null ? fmtMoney(business, parsed.totalMinor) : "—"}</span>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Compact price cell inside a line row. */
function MoneyInputMini({
  id,
  symbol,
  value,
  onChange,
  label,
  precision,
}: {
  id: string;
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
  precision: number;
}) {
  let valid = true;
  try {
    toMinor(value === "" ? "0" : value, precision);
  } catch {
    valid = false;
  }
  return (
    <div className="relative sm:mt-0">
      <span className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 z-10 -translate-y-1/2 text-xs">
        {symbol}
      </span>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        dir="ltr"
        inputMode="decimal"
        aria-label={label}
        className={`h-9 ps-6 text-end ${!valid ? "border-destructive" : ""}`}
      />
    </div>
  );
}

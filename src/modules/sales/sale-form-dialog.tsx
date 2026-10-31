"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Plus, ReceiptText, Trash2 } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { toMinor, vatMinor, formatBpAsPercent } from "@/lib/money";
import { moneyToMinorOrNull } from "@/components/shared/table-kit";
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

/** Tiny visible caption above an inline field (qty / unit price / amount). */
function FieldCaption({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground block text-[11px] leading-none">{children}</span>;
}

/**
 * Create-invoice dialog. Line totals and the grand total are computed with
 * integer math (toMinor per row) and RECOMPUTED server-side — the client
 * preview is presentational only (A08).
 *
 * Presentation: every invoice line renders as a self-contained framed card
 * (identical structure on mobile and desktop), so fields can never drift out
 * of alignment regardless of direction (RTL/LTR) or viewport.
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
    // §F3 — mirror of the server law: VAT is applied by the BUSINESS CONFIG,
    // computed from the taxable base with the exact same integer math.
    const vatRateBp = business.vatEnabled ? Math.max(0, business.vatRateBp ?? 0) : 0;
    let taxMinor: number | null = null;
    try {
      taxMinor = discountValid
        ? vatMinor(Math.max(0, subtotalMinor - discountMinor), vatRateBp)
        : null;
    } catch {
      taxMinor = null;
    }
    const totalMinor =
      discountValid && taxMinor !== null
        ? subtotalMinor - discountMinor + taxMinor
        : null;
    return { rows, allValid, subtotalMinor, discountMinor, discountValid, vatRateBp, taxMinor, totalMinor };
  }, [lines, discount, precision, business.vatEnabled, business.vatRateBp]);

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

  // Show the completion hint only once the user has started filling lines —
  // avoids nagging on a freshly opened, intentionally empty draft.
  const linesTouched = lines.some(
    (l) =>
      l.name.trim() !== "" ||
      l.unitPrice.trim() !== "" ||
      (l.qty.trim() !== "" && l.qty.trim() !== "1"),
  );
  const showLinesHint = linesTouched && !parsed.allValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] gap-0 overflow-y-auto p-6 pb-0 sm:max-w-2xl">
        <DialogHeader className="gap-3 text-start">
          <DialogTitle className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-sm dark:from-emerald-500 dark:to-teal-400"
            >
              <ReceiptText className="size-4.5" />
            </span>
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
          className="mt-4 space-y-5"
          noValidate
        >
          {/* Customer */}
          <div className="space-y-2">
            <Label htmlFor="sale-customer">
              {t("customer")} <span className="text-muted-foreground">({tCommon("optional")})</span>
            </Label>
            <Select value={customerId || NONE} onValueChange={(v) => setCustomerId(v === NONE ? "" : v)}>
              <SelectTrigger id="sale-customer" className="h-10 w-full">
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

          {/* Line items — framed cards, identical structure at every viewport */}
          <section aria-label={t("items")} className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-semibold">{t("items")}</Label>
                <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
                  {lines.length}
                </span>
              </div>
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

            <div className="space-y-2.5">
              {lines.map((l, idx) => {
                const row = parsed.rows[idx];
                const qtyInvalid = row?.qty == null || row.qty < 1;
                return (
                  <div
                    key={l.key}
                    className="bg-card/60 focus-within:border-ring/60 hover:border-border/90 rounded-xl border p-3 shadow-xs transition-colors motion-reduce:transition-none"
                  >
                    {/* Line head: order badge + item picker + remove */}
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold tabular-nums"
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
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
                            className="mt-1.5 h-9"
                            dir="auto"
                            aria-label={t("itemNamePlaceholder")}
                          />
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 size-8 shrink-0"
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        aria-label={tCommon("delete")}
                        title={tCommon("delete")}
                        disabled={lines.length <= 1}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>

                    {/* Qty / unit price / line total */}
                    <div className="mt-2.5 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-2 sm:grid-cols-[3.5rem_10rem_minmax(0,1fr)]">
                      <div className="space-y-1">
                        <FieldCaption>{t("colQty")}</FieldCaption>
                        <Input
                          value={l.qty}
                          onChange={(e) => updateLine(l.key, { qty: e.target.value })}
                          inputMode="numeric"
                          className={`h-9 text-center tabular-nums ${qtyInvalid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                          aria-label={t("colQty")}
                          aria-invalid={qtyInvalid}
                          dir="ltr"
                        />
                      </div>
                      <div className="space-y-1">
                        <FieldCaption>{t("colUnitPrice")}</FieldCaption>
                        <MoneyInputMini
                          id={`price-${l.key}`}
                          symbol={business.currencySymbol}
                          value={l.unitPrice}
                          onChange={(v) => updateLine(l.key, { unitPrice: v })}
                          label={t("colUnitPrice")}
                          precision={precision}
                        />
                      </div>
                      <div className="col-span-2 flex items-end justify-between gap-2 sm:col-span-1">
                        <FieldCaption>{t("colLineTotal")}</FieldCaption>
                        <span
                          className={`pb-1.5 text-sm font-semibold tabular-nums ${
                            row?.lineTotalMinor == null ? "text-muted-foreground font-normal" : ""
                          }`}
                          dir="ltr"
                        >
                          {row?.lineTotalMinor != null
                            ? fmtMoney(business, row.lineTotalMinor)
                            : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {showLinesHint ? (
              <p className="text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-xs">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
                {t("fixLinesHint")}
              </p>
            ) : null}
          </section>

          {/* Totals summary — discount edits inline, total gets the brand gradient */}
          <div className="bg-muted/30 ms-auto w-full max-w-sm space-y-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground shrink-0">{t("subtotal")}</span>
              <span className="font-medium tabular-nums" dir="ltr">
                {fmtMoney(business, parsed.subtotalMinor)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground shrink-0">{t("discount")}</span>
              <div className="w-32">
                <MoneyInputMini
                  id="sale-discount"
                  symbol={business.currencySymbol}
                  value={discount}
                  onChange={setDiscount}
                  label={t("discount")}
                  precision={precision}
                  forceInvalid={!parsed.discountValid}
                />
              </div>
            </div>
            {!parsed.discountValid ? (
              <p className="text-destructive text-end text-xs">{t("invalidDiscount")}</p>
            ) : null}
            {parsed.vatRateBp > 0 && parsed.taxMinor != null ? (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground shrink-0">
                  {t("vatLabel")} ({formatBpAsPercent(parsed.vatRateBp)})
                </span>
                <span className="font-medium tabular-nums" dir="ltr">
                  {fmtMoney(business, parsed.taxMinor)}
                </span>
              </div>
            ) : null}
            <Separator />
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{t("total")}</span>
              <span
                className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-lg font-bold tabular-nums text-transparent dark:from-emerald-400 dark:to-teal-300"
                dir="ltr"
              >
                {parsed.totalMinor != null ? fmtMoney(business, parsed.totalMinor) : "—"}
              </span>
            </div>
          </div>

          {/* Note */}
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
              className="resize-y"
            />
          </div>

          {/* Sticky action bar — always reachable while the dialog scrolls */}
          <DialogFooter className="sticky bottom-0 -mx-6 gap-2 border-t bg-background/95 px-6 py-4 backdrop-blur sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit || mutation.isPending} className="min-w-32">
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ReceiptText className="size-4" aria-hidden="true" />
              )}
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
  forceInvalid = false,
}: {
  id: string;
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
  precision: number;
  /** Semantic invalidity beyond parsing (e.g. discount > subtotal). */
  forceInvalid?: boolean;
}) {
  let valid = true;
  try {
    toMinor(value === "" ? "0" : value, precision);
  } catch {
    valid = false;
  }
  valid = valid && !forceInvalid;
  return (
    <div className="relative">
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
        className={`h-9 text-end ltr:pl-9 rtl:pr-9 ${!valid ? "border-destructive" : ""}`}
      />
    </div>
  );
}

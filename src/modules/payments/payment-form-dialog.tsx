"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api, ApiClientError } from "@/lib/api-client";
import { moneyToMinorOrNull } from "@/components/shared/table-kit";
import { MoneyInput } from "@/components/shared/table-kit";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { fmtMoney, useInvalidateFinance } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

type OpenSale = { id: string; number: number; customerName: string | null; balanceMinor: number };
type OpenExpense = { id: string; category: string; supplierName: string | null; balanceMinor: number };

export type PaymentTarget =
  | { kind: "sale"; id: string; number: number; customerName: string | null; balanceMinor: number }
  | { kind: "expense"; id: string; category: string; supplierName: string | null; balanceMinor: number };

const METHODS = ["CASH", "BANK_TRANSFER", "CARD", "OTHER"] as const;

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Record-a-payment dialog shared by the payments module, receivables /
 * payables quick actions and the invoice detail view.
 * The server re-validates balance and permission (finance:manage).
 */
export function PaymentFormDialog({
  open,
  onOpenChange,
  business,
  presetTarget,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  business: BusinessSummary;
  presetTarget?: PaymentTarget | null;
}) {
  const t = useTranslations("finance.paymentForm");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const invalidate = useInvalidateFinance();

  const [targetValue, setTargetValue] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);

  // Load open (unpaid/partial) sales + expenses when no preset target.
  const needsPicker = !presetTarget;
  const { data: unpaidSales } = useQuery<OpenSale[]>({
    queryKey: ["sales", "open-for-payment"],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api<{ items: OpenSale[] }>("/api/v1/sales?status=UNPAID&pageSize=100"),
        api<{ items: OpenSale[] }>("/api/v1/sales?status=PARTIAL&pageSize=100"),
      ]);
      return [...a.items, ...b.items];
    },
    enabled: open && needsPicker,
    staleTime: 10_000,
  });
  const { data: unpaidExpenses } = useQuery<OpenExpense[]>({
    queryKey: ["expenses", "open-for-payment"],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api<{ items: OpenExpense[] }>("/api/v1/expenses?status=UNPAID&pageSize=100"),
        api<{ items: OpenExpense[] }>("/api/v1/expenses?status=PARTIAL&pageSize=100"),
      ]);
      return [...a.items, ...b.items];
    },
    enabled: open && needsPicker,
    staleTime: 10_000,
  });

  const targets: PaymentTarget[] = useMemo(() => {
    if (presetTarget) return [presetTarget];
    const sales = (unpaidSales ?? []).map<PaymentTarget>((s) => ({
      kind: "sale",
      id: s.id,
      number: s.number,
      customerName: s.customerName,
      balanceMinor: s.balanceMinor,
    }));
    const expenses = (unpaidExpenses ?? []).map<PaymentTarget>((e) => ({
      kind: "expense",
      id: e.id,
      category: e.category,
      supplierName: e.supplierName,
      balanceMinor: e.balanceMinor,
    }));
    return [...sales, ...expenses];
  }, [presetTarget, unpaidSales, unpaidExpenses]);

  const targetKey = (t2: PaymentTarget) =>
    t2.kind === "sale" ? `sale:${t2.id}` : `expense:${t2.id}`;
  const selected = presetTarget ?? targets.find((t2) => targetValue === targetKey(t2));

  // Reset the form each time the dialog opens (render-adjust pattern —
  // no setState inside effects).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setAmountTouched(false);
      setNote("");
      setDate(todayISO());
      setMethod("CASH");
      setTargetValue("");
      setAmount("");
    }
  }

  // Default the amount to the outstanding balance whenever the target
  // changes and the user has not typed a custom amount yet.
  const [lastTargetKey, setLastTargetKey] = useState<string | null>(null);
  const selectedKey = selected ? targetKey(selected) : null;
  if (selectedKey !== lastTargetKey) {
    setLastTargetKey(selectedKey);
    if (selected && !amountTouched) {
      setAmount(String(selected.balanceMinor / 10 ** business.decimalPrecision));
    }
  }

  const amountMinor = moneyToMinorOrNull(amount, business.decimalPrecision);
  const overLimit = selected != null && amountMinor != null && amountMinor > selected.balanceMinor;
  const canSubmit = selected != null && amountMinor != null && amountMinor > 0 && !overLimit;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("no target");
      const body = JSON.stringify({
        ...(selected.kind === "sale" ? { saleId: selected.id } : { expenseId: selected.id }),
        amountMinor,
        method,
        note: note || null,
        paidAt: new Date(`${date}T12:00:00.000Z`).toISOString(),
      });
      return api("/api/v1/payments", { method: "POST", body });
    },
    onSuccess: () => {
      toast({ title: t("savedToast") });
      onOpenChange(false);
      invalidate();
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  function labelOf(t2: PaymentTarget): string {
    return t2.kind === "sale"
      ? t("targetSale", {
          number: `INV-${String(t2.number).padStart(4, "0")}`,
          name: t2.customerName ?? t("walkIn"),
          balance: fmtMoney(business, t2.balanceMinor),
        })
      : t("targetExpense", {
          category: t2.category,
          name: t2.supplierName ?? t("noSupplier"),
          balance: fmtMoney(business, t2.balanceMinor),
        });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
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
            <Label htmlFor="pay-target">{t("target")}</Label>
            {presetTarget ? (
              <Input id="pay-target" value={labelOf(presetTarget)} readOnly dir="auto" />
            ) : targets.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm">
                {t("nothingDue")}
              </p>
            ) : (
              <Select
                value={targetValue}
                onValueChange={(v) => {
                  setTargetValue(v);
                  setAmountTouched(false);
                }}
              >
                <SelectTrigger id="pay-target" className="w-full">
                  <SelectValue placeholder={t("targetPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {unpaidSales && unpaidSales.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{t("groupSales")}</SelectLabel>
                      {targets
                        .filter((x) => x.kind === "sale")
                        .map((x) => (
                          <SelectItem key={x.id} value={targetKey(x)} dir="auto">
                            {labelOf(x)}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ) : null}
                  {unpaidExpenses && unpaidExpenses.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{t("groupExpenses")}</SelectLabel>
                      {targets
                        .filter((x) => x.kind === "expense")
                        .map((x) => (
                          <SelectItem key={x.id} value={targetKey(x)} dir="auto">
                            {labelOf(x)}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyInput
              id="pay-amount"
              label={t("amount")}
              symbol={business.currencySymbol}
              value={amount}
              precision={business.decimalPrecision}
              onChange={(v) => {
                setAmount(v);
                setAmountTouched(true);
              }}
              invalidMsg={t("invalidAmount")}
            />
            <div className="space-y-2">
              <Label htmlFor="pay-method">{t("method")}</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as (typeof METHODS)[number])}>
                <SelectTrigger id="pay-method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`methods.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pay-date">{t("date")}</Label>
            <Input
              id="pay-date"
              type="date"
              value={date}
              max={todayISO()}
              onChange={(e) => setDate(e.target.value)}
              dir="ltr"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pay-note">
              {t("note")} <span className="text-muted-foreground">({tCommon("optional")})</span>
            </Label>
            <Textarea
              id="pay-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>

          {selected ? (
            <p className="text-muted-foreground text-xs tabular-nums" dir="auto">
              {t("outstanding")}: <span className="font-medium">{fmtMoney(business, selected.balanceMinor)}</span>
            </p>
          ) : null}
          {overLimit ? (
            <p className="text-destructive text-xs" role="alert">
              {t("overLimit")}
            </p>
          ) : null}

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

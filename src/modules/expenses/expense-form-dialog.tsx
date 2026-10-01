"use client";

/**
 * Prompt 34 — expense form dialog, EXTRACTED from expenses-view so the
 * Expenses list and the expense DETAIL page share ONE create/edit form
 * (§29/§75). Behavior is identical; onSuccess also invalidates the affected
 * expense detail (§37, targeted).
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { fromMinor } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormDialog, MoneyInput, moneyToMinorOrNull } from "@/components/shared/table-kit";
import { useAppStore } from "@/store/app-store";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import { useInvalidateFinance } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

const CATEGORY_SUGGESTIONS = [
  "Rent",
  "Salaries",
  "Utilities",
  "Supplies",
  "Marketing",
  "Transport",
  "Software",
  "Other",
];

// Radix Select forbids empty-string item values — sentinel maps to "".
const NONE = "__none__";

type ExpenseForm = { supplierId: string; category: string; amount: string; note: string };

export type ExpenseEditRow = {
  id: string;
  category: string;
  amountMinor: number;
  note: string | null;
};

function formFrom(
  e: ExpenseEditRow | null,
  precision: number,
  presetSupplierId?: string | null,
): ExpenseForm {
  if (e) {
    return { supplierId: "", category: e.category, amount: String(fromMinor(e.amountMinor, precision)), note: e.note ?? "" };
  }
  return { supplierId: presetSupplierId ?? "", category: "", amount: "", note: "" };
}

export function ExpenseFormDialog({
  open,
  onOpenChange,
  editing,
  business,
  presetSupplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ExpenseEditRow | null;
  business: BusinessSummary;
  /** Pre-selected supplier — e.g. "New expense" from the supplier 360 page. */
  presetSupplier?: { id: string; name: string } | null;
  /** Invoked after a successful save — lets 360 pages refresh their data. */
  onSaved?: () => void;
}) {
  const t = useTranslations("finance.expenses");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const invalidateFinance = useInvalidateFinance();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const [form, setForm] = useState<ExpenseForm>(() =>
    formFrom(editing, business.decimalPrecision, presetSupplier?.id),
  );

  // Render-phase reset when the dialog opens (React-sanctioned adjustment).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open)
      setForm(formFrom(editing, business.decimalPrecision, presetSupplier?.id));
  }

  // Supplier options — only fetched while the dialog is open (same as the
  // original list dialog; staleTime keeps repeated opens cheap).
  const { data: suppliers } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["suppliers", "options"],
    queryFn: async () => {
      const res = await api<{ items: { id: string; name: string }[] }>(
        "/api/v1/suppliers?pageSize=100",
      );
      return res.items;
    },
    enabled: open,
    staleTime: 15_000,
  });

  // The preset supplier may live beyond the first options page — merge it
  // into the selectable list so the Select always renders its name.
  const supplierOptions = useMemo(() => {
    const list = suppliers ?? [];
    if (presetSupplier && !list.some((s) => s.id === presetSupplier.id)) {
      return [{ id: presetSupplier.id, name: presetSupplier.name }, ...list];
    }
    return list;
  }, [suppliers, presetSupplier]);

  const amountMinor = moneyToMinorOrNull(form.amount, business.decimalPrecision);
  const canSubmit =
    form.category.trim().length > 0 && amountMinor != null && amountMinor >= 1;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({
        category: form.category,
        amountMinor,
        note: form.note || null,
        ...(form.supplierId ? { supplierId: form.supplierId } : {}),
      });
      return editing
        ? api(`/api/v1/expenses/${editing.id}`, { method: "PATCH", body })
        : api("/api/v1/expenses", { method: "POST", body });
    },
    onSuccess: () => {
      toast({ title: editing ? t("updatedToast") : t("createdToast") });
      onOpenChange(false);
      // Same invalidation set as the list's own mutation (finance-wide).
      invalidateFinance();
      // §37 — the open expense detail (if any) converges to server state.
      if (editing) invalidateEntityDetail(queryClient, businessId, "expense", editing.id);
      onSaved?.();
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("editTitle") : t("addExpense")}
      submitLabel={editing ? tCommon("save") : tCommon("add")}
      cancelLabel={tCommon("cancel")}
      pending={saveMutation.isPending}
      disabled={!canSubmit}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) saveMutation.mutate();
      }}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="exp-category">{t("category")}</Label>
            <Input
              id="exp-category"
              value={form.category}
              onChange={(e2) => setForm({ ...form, category: e2.target.value })}
              placeholder={t("categoryPlaceholder")}
              maxLength={60}
              list="expense-categories"
              required
            />
            <datalist id="expense-categories">
              {CATEGORY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exp-supplier">
              {t("supplier")}{" "}
              <span className="text-muted-foreground">({tCommon("optional")})</span>
            </Label>
            <Select
              value={form.supplierId || NONE}
              onValueChange={(v) => setForm({ ...form, supplierId: v === NONE ? "" : v })}
            >
              <SelectTrigger id="exp-supplier" className="w-full">
                <SelectValue placeholder={t("supplierPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("noSupplier")}</SelectItem>
                {(supplierOptions).map((s) => (
                  <SelectItem key={s.id} value={s.id} dir="auto">
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <MoneyInput
          id="exp-amount"
          label={t("amount")}
          symbol={business.currencySymbol}
          value={form.amount}
          precision={business.decimalPrecision}
          onChange={(v) => setForm({ ...form, amount: v })}
          invalidMsg={t("invalidAmount")}
        />
        <div className="space-y-2">
          <Label htmlFor="exp-note">
            {t("note")} <span className="text-muted-foreground">({tCommon("optional")})</span>
          </Label>
          <Textarea
            id="exp-note"
            value={form.note}
            onChange={(e2) => setForm({ ...form, note: e2.target.value })}
            rows={2}
            maxLength={1000}
          />
        </div>
      </div>
    </FormDialog>
  );
}

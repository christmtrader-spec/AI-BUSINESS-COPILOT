"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Banknote, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, asRole, type Role } from "@/lib/rbac";
import { MoneyInput, moneyToMinorOrNull } from "@/components/shared/table-kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { FormDialog, Pagination, SearchInput } from "@/components/shared/table-kit";
import {
  FinanceStatusBadge,
  fmtDate,
  fmtMoney,
  txKeys,
  useInvalidateFinance,
} from "../finance-shared/finance-kit";
import { PaymentFormDialog, type PaymentTarget } from "../payments/payment-form-dialog";
import type { BusinessSummary } from "../shell/types";

type ExpenseRow = {
  id: string;
  supplierName: string | null;
  category: string;
  amountMinor: number;
  paidMinor: number;
  status: string;
  balanceMinor: number;
  spentAt: string;
  note: string | null;
};

type ExpensesPage = { items: ExpenseRow[]; total: number; page: number; pageSize: number };

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

const STATUS_FILTERS = ["ALL", "UNPAID", "PARTIAL", "PAID"] as const;

// Radix Select forbids empty-string item values — sentinel maps to "".
const NONE = "__none__";

/** Expenses module — record costs, track paid/balance, pay suppliers. */
export function ExpensesView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("finance.expenses");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const invalidate = useInvalidateFinance();

  const writable = can(asRole(role), "data:write");
  const canPay = can(asRole(role), "finance:manage");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [payTarget, setPayTarget] = useState<PaymentTarget | null>(null);
  const [form, setForm] = useState({
    supplierId: "",
    category: "",
    amount: "",
    note: "",
  });

  const statusQs = status === "ALL" ? "" : `&status=${status}`;
  const { data, isLoading, error, refetch } = useQuery<ExpensesPage>({
    queryKey: [...txKeys.expenses, q, page, status],
    queryFn: () =>
      api(`/api/v1/expenses?q=${encodeURIComponent(q)}&page=${page}&pageSize=10${statusQs}`),
  });

  const { data: suppliers } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["suppliers", "options"],
    queryFn: async () => {
      const res = await api<{ items: { id: string; name: string }[] }>(
        "/api/v1/suppliers?pageSize=100",
      );
      return res.items;
    },
    enabled: dialogOpen,
    staleTime: 15_000,
  });

  function openCreate() {
    setEditing(null);
    setForm({ supplierId: "", category: "", amount: "", note: "" });
    setDialogOpen(true);
  }

  function openEdit(e: ExpenseRow) {
    setEditing(e);
    setForm({
      supplierId: "",
      category: e.category,
      amount: String(e.amountMinor / 10 ** business.decimalPrecision),
      note: e.note ?? "",
    });
    setDialogOpen(true);
  }

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
      setDialogOpen(false);
      invalidate();
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      invalidate();
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-6" data-view="module:expenses">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          writable ? (
            <Button onClick={openCreate} size="sm">
              <Plus className="size-4" aria-hidden="true" />
              {t("addExpense")}
            </Button>
          ) : null
        }
      />

      {error ? (
        <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
          {tErrors("loadFailed")}{" "}
          <button className="underline" onClick={() => void refetch()}>
            {tCommon("retry")}
          </button>
        </div>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as (typeof STATUS_FILTERS)[number]);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label={t("statusFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "ALL" ? t("allStatuses") : t(`status_${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted/50 h-12 animate-pulse rounded-md" />
              ))}
            </div>
          ) : items.length === 0 && !q && status === "ALL" ? (
            <EmptyState
              icon={Wallet}
              title={t("empty")}
              description={t("emptyDesc")}
              action={
                writable ? (
                  <Button size="sm" variant="outline" onClick={openCreate}>
                    <Plus className="size-4" aria-hidden="true" />
                    {t("addExpense")}
                  </Button>
                ) : null
              }
            />
          ) : items.length === 0 ? (
            <EmptyState icon={Wallet} title={tCommon("search")} description={t("searchPlaceholder")} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colCategory")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("colSupplier")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("colDate")}</TableHead>
                      <TableHead className="text-end">{t("colAmount")}</TableHead>
                      <TableHead className="hidden text-end md:table-cell">{t("colBalance")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead className="text-end">{tCommon("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((e) => (
                      <TableRow key={e.id} className="hover:bg-muted/40">
                        <TableCell dir="auto">
                          <span className="font-medium">{e.category}</span>
                          {e.note ? (
                            <p className="text-muted-foreground max-w-40 truncate text-xs" dir="auto">
                              {e.note}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden max-w-36 truncate md:table-cell" dir="auto">
                          {e.supplierName ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden whitespace-nowrap text-sm sm:table-cell">
                          {fmtDate(business, e.spentAt)}
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums" dir="ltr">
                          {fmtMoney(business, e.amountMinor)}
                        </TableCell>
                        <TableCell
                          className={`hidden text-end tabular-nums md:table-cell ${
                            e.balanceMinor > 0 ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"
                          }`}
                          dir="ltr"
                        >
                          {fmtMoney(business, e.balanceMinor)}
                        </TableCell>
                        <TableCell>
                          <FinanceStatusBadge status={e.status} />
                        </TableCell>
                        <TableCell className="text-end">
                          <div className="flex items-center justify-end gap-1">
                            {canPay && e.balanceMinor > 0 ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() =>
                                  setPayTarget({
                                    kind: "expense",
                                    id: e.id,
                                    category: e.category,
                                    supplierName: e.supplierName,
                                    balanceMinor: e.balanceMinor,
                                  })
                                }
                                aria-label={t("pay")}
                              >
                                <Banknote className="size-4" />
                              </Button>
                            ) : null}
                            {writable ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  onClick={() => openEdit(e)}
                                  aria-label={tCommon("edit")}
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="text-destructive hover:text-destructive size-8"
                                      aria-label={tCommon("delete")}
                                    >
                                      <Trash2 className="size-4" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                                      <AlertDialogDescription>{t("deleteDesc")}</AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                                      <AlertDialogAction
                                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        onClick={() => deleteMutation.mutate(e.id)}
                                      >
                                        {tCommon("delete")}
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={page}
                pageSize={10}
                total={data?.total ?? 0}
                onPage={setPage}
                labels={{
                  prev: tCommon("previous"),
                  next: tCommon("next"),
                  of: business.locale === "fa" ? "از" : "of",
                }}
              />
            </>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
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
                  {(suppliers ?? []).map((s) => (
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

      <PaymentFormDialog
        open={payTarget != null}
        onOpenChange={(v) => setPayTarget(v ? payTarget : null)}
        business={business}
        presetTarget={payTarget}
      />
    </div>
  );
}

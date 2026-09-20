"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeftRight, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { formatMoney, fromMinor } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
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
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import {
  FormDialog,
  MoneyInput,
  Pagination,
  SearchInput,
  moneyToMinorOrNull,
} from "@/components/shared/table-kit";
import { StockDialog } from "./stock-dialog";
import type { BusinessSummary } from "../shell/types";

export type Product = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  salePriceMinor: number;
  costPriceMinor: number;
  stockQty: number;
  lowStockAt: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProductPage = { items: Product[]; total: number; page: number; pageSize: number };

export function ProductsView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("products");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const writable = can(role, "data:write");
  const precision = business.decimalPrecision;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [stockTarget, setStockTarget] = useState<Product | null>(null);
  const [form, setForm] = useState({
    name: "",
    sku: "",
    unit: "",
    salePrice: "",
    costPrice: "",
    stockQty: "0",
    lowStockAt: "5",
  });

  const { data, isLoading, error, refetch } = useQuery<ProductPage>({
    queryKey: ["products", q, page],
    queryFn: () => api(`/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`),
  });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", sku: "", unit: "", salePrice: "", costPrice: "", stockQty: "0", lowStockAt: "5" });
    setDialogOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm({
      name: p.name,
      sku: p.sku ?? "",
      unit: p.unit ?? "",
      salePrice: String(fromMinor(p.salePriceMinor, precision)),
      costPrice: String(fromMinor(p.costPriceMinor, precision)),
      stockQty: String(p.stockQty),
      lowStockAt: String(p.lowStockAt),
    });
    setDialogOpen(true);
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
        ...(editing
          ? { lowStockAt }
          : { stockQty: Number.isInteger(stockQty) ? stockQty : 0, lowStockAt }),
      });
      return editing
        ? api(`/api/v1/products/${editing.id}`, { method: "PATCH", body })
        : api("/api/v1/products", { method: "POST", body });
    },
    onSuccess: () => {
      toast({ title: editing ? t("updatedToast") : t("createdToast") });
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["adjustments"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/products/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const fmt = (minor: number) => formatMoney(minor, business);

  function stockBadge(p: Product) {
    if (p.stockQty <= 0) {
      return <Badge variant="destructive">{t("stockOut")}</Badge>;
    }
    if (p.stockQty <= p.lowStockAt) {
      return (
        <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" variant="outline">
          {t("stockLow")}
        </Badge>
      );
    }
    return null;
  }

  return (
    <div className="space-y-6" data-view="module:products">
      <PageHeader
        title={tNav("products")}
        subtitle={t("priceNote")}
        actions={
          writable ? (
            <Button onClick={openCreate} size="sm">
              <Plus className="size-4" aria-hidden="true" />
              {t("add")}
            </Button>
          ) : null
        }
      />
      <Card>
        <CardContent className="pt-6">
          <div className="mb-4">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
          </div>

          {isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted/50 h-12 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : items.length === 0 && !q ? (
            <EmptyState
              icon={Package}
              title={t("empty")}
              description={t("emptyDesc")}
              action={
                writable ? (
                  <Button size="sm" variant="outline" onClick={openCreate}>
                    <Plus className="size-4" aria-hidden="true" />
                    {t("add")}
                  </Button>
                ) : null
              }
            />
          ) : items.length === 0 ? (
            <EmptyState icon={Package} title={tCommon("search")} description={t("searchPlaceholder")} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colProduct")}</TableHead>
                      <TableHead className="text-end">{t("colPrice")}</TableHead>
                      <TableHead>{t("colStock")}</TableHead>
                      {writable ? (
                        <TableHead className="text-end">{tCommon("actions")}</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((p) => (
                      <TableRow key={p.id} className="hover:bg-muted/40">
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
                              <Package className="text-primary size-4" aria-hidden="true" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{p.name}</p>
                              {p.sku ? (
                                <p className="text-muted-foreground text-xs" dir="ltr">
                                  {p.sku}
                                  {p.unit ? ` · ${p.unit}` : ""}
                                </p>
                              ) : p.unit ? (
                                <p className="text-muted-foreground text-xs">{p.unit}</p>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-end font-semibold tabular-nums">
                          {fmt(p.salePriceMinor)}
                          <p className="text-muted-foreground text-xs font-normal tabular-nums">
                            {fmt(p.costPriceMinor)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold tabular-nums">{p.stockQty}</span>
                            {stockBadge(p)}
                          </div>
                        </TableCell>
                        {writable ? (
                          <TableCell className="text-end">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => setStockTarget(p)}
                                aria-label={t("adjust")}
                              >
                                <ArrowLeftRight className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => openEdit(p)}
                                aria-label={t("edit")}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-destructive size-8 hover:text-destructive"
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
                                      onClick={() => deleteMutation.mutate(p.id)}
                                    >
                                      {tCommon("delete")}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination page={page} pageSize={10} total={total} onPage={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? t("edit") : t("add")}
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

      {stockTarget ? (
        <StockDialog product={stockTarget} onClose={() => setStockTarget(null)} />
      ) : null}
    </div>
  );
}

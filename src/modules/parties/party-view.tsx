"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Download, Pencil, Plus, Trash2, Users } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { downloadCsv, exportStamp, toCsv } from "@/lib/csv";
import { can, asRole, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { FormDialog, Pagination, SearchInput } from "@/components/shared/table-kit";
import { PlanLimitBanner } from "../billing/plan-limit-banner";
import type { BusinessSummary } from "../shell/types";

export type Party = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  createdAt: string;
};

type PartyPage = { items: Party[]; total: number; page: number; pageSize: number };

const API_BASE = { customer: "/api/v1/customers", supplier: "/api/v1/suppliers" } as const;

/**
 * Generic master-data view for parties (customers & suppliers) — Rule 04:
 * one implementation, two configurations. Server enforces tenant + RBAC;
 * UI gating is a convenience only.
 */
export function PartyView({
  kind,
  business,
  role,
}: {
  kind: "customer" | "supplier";
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("parties");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const writable = can(role, "data:write");
  const typeLabel = t(kind);
  const typePlural = kind === "customer" ? t("customers") : t("suppliers");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", note: "" });

  const { data, isLoading, error, refetch } = useQuery<PartyPage>({
    queryKey: ["parties", kind, q, page],
    queryFn: () =>
      api(`${API_BASE[kind]}?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`),
  });

  function openCreate() {
    setEditing(null);
    setForm({ name: "", phone: "", email: "", address: "", note: "" });
    setDialogOpen(true);
  }

  function openEdit(p: Party) {
    setEditing(p);
    setForm({
      name: p.name,
      phone: p.phone ?? "",
      email: p.email ?? "",
      address: p.address ?? "",
      note: p.note ?? "",
    });
    setDialogOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({
        name: form.name,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        note: form.note || null,
      });
      return editing
        ? api(`${API_BASE[kind]}/${editing.id}`, { method: "PATCH", body })
        : api(API_BASE[kind], { method: "POST", body });
    },
    onSuccess: () => {
      toast({ title: t(editing ? "updatedToast" : "createdToast", { type: typeLabel }) });
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["parties", kind] });
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
    mutationFn: async (id: string) => api(`${API_BASE[kind]}/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast", { type: typeLabel }) });
      void queryClient.invalidateQueries({ queryKey: ["parties", kind] });
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
  const dateFmt = new Intl.DateTimeFormat(business.locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
  });

  // Export the full (soft-delete-aware) list — up to 500 rows — as CSV.
  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await api<PartyPage>(
        `${API_BASE[kind]}?q=&page=1&pageSize=500`,
      );
      const csv = toCsv(
        [t("colName"), t("colContact"), t("colNote"), t("colCreated")],
        res.items.map((p) => [
          p.name,
          [p.phone, p.email].filter(Boolean).join(" "),
          p.note ?? "",
          dateFmt.format(new Date(p.createdAt)),
        ]),
      );
      downloadCsv(`${kind}s-${exportStamp()}.csv`, csv);
      return res.total;
    },
    onSuccess: (count) => toast({ title: t("exportedToast", { count }) }),
    onError: () => toast({ title: tErrors("generic"), variant: "destructive" }),
  });

  return (
    <div className="space-y-6" data-view={`module:${kind}s`}>
      <PageHeader
        title={typePlural}
        subtitle={t("subtitle", { type: typeLabel })}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={exportMutation.isPending}
              onClick={() => exportMutation.mutate()}
            >
              <Download className="size-4" aria-hidden="true" />
              {tCommon("exportCsv")}
            </Button>
            {writable ? (
              <Button onClick={openCreate} size="sm">
                <Plus className="size-4" aria-hidden="true" />
                {t("add", { type: typeLabel })}
              </Button>
            ) : null}
          </>
        }
      />

      {/* Prompt 20: informational plan-limit banner (server enforces the
          same limit on create — this only makes the boundary visible). */}
      {kind === "customer" ? <PlanLimitBanner code="CUSTOMERS_MAX" /> : null}

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
          ) : (
            <>
              <DataTable<Party>
                ariaLabel={typePlural}
                sortLocale={business.locale}
                columns={[
                  {
                    id: "name",
                    header: t("colName"),
                    sortValue: (p) => p.name,
                    cell: (p) => (
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8 ring-1 ring-border">
                          <AvatarFallback className="bg-emerald-500/10 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            {p.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{p.name}</span>
                      </div>
                    ),
                  },
                  {
                    id: "contact",
                    header: t("colContact"),
                    cell: (p) => (
                      <div className="text-sm">
                        {p.phone ? (
                          <div>
                            <Ltr className="text-[13px]">{p.phone}</Ltr>
                          </div>
                        ) : null}
                        {p.email ? (
                          <div className="text-muted-foreground text-xs">
                            <Ltr>{p.email}</Ltr>
                          </div>
                        ) : null}
                        {!p.phone && !p.email ? (
                          <span className="text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    id: "note",
                    header: t("colNote"),
                    hideBelow: "md",
                    cell: (p) => (
                      <div className="text-muted-foreground max-w-52 truncate text-sm">
                        {p.note ?? "—"}
                      </div>
                    ),
                  },
                  {
                    id: "created",
                    header: t("colCreated"),
                    hideBelow: "sm",
                    sortValue: (p) => p.createdAt,
                    defaultSortDir: "desc",
                    cell: (p) => (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {dateFmt.format(new Date(p.createdAt))}
                      </span>
                    ),
                  },
                  ...(writable
                    ? [
                        {
                          id: "actions",
                          header: tCommon("actions"),
                          align: "end" as const,
                          cell: (p: Party) => (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground hover:text-foreground size-8"
                                onClick={() => openEdit(p)}
                                aria-label={t("edit", { type: typeLabel })}
                              >
                                <Pencil className="size-4" aria-hidden="true" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-muted-foreground size-8 hover:bg-destructive/10 hover:text-destructive"
                                    aria-label={tCommon("delete")}
                                  >
                                    <Trash2 className="size-4" aria-hidden="true" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      {t("deleteTitle", { type: typeLabel })}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {t("deleteDesc")}
                                    </AlertDialogDescription>
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
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={items}
                getRowId={(p) => p.id}
                loading={isLoading}
                skeletonRows={4}
                empty={
                  items.length === 0 && !q ? (
                    <EmptyState
                      icon={Users}
                      title={t("empty", { type: typeLabel })}
                      description={t("emptyDesc", { type: typeLabel })}
                      action={
                        writable ? (
                          <Button size="sm" variant="outline" onClick={openCreate}>
                            <Plus className="size-4" aria-hidden="true" />
                            {t("add", { type: typeLabel })}
                          </Button>
                        ) : null
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={Users}
                      title={tCommon("search")}
                      description={t("searchPlaceholder")}
                    />
                  )
                }
              />
              <Pagination
                page={page}
                pageSize={10}
                total={total}
                onPage={setPage}
                labels={{ prev: tCommon("previous"), next: tCommon("next") }}
              />
            </>
          )}
        </CardContent>
      </Card>

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? t("edit", { type: typeLabel }) : t("add", { type: typeLabel })}
        submitLabel={editing ? tCommon("save") : tCommon("add")}
        cancelLabel={tCommon("cancel")}
        pending={saveMutation.isPending}
        disabled={!form.name.trim()}
        onSubmit={(e) => {
          e.preventDefault();
          if (form.name.trim()) saveMutation.mutate();
        }}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="p-name">{t("name")}</Label>
            <Input
              id="p-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t("namePlaceholder")}
              maxLength={120}
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p-phone">{t("phone")}</Label>
              <Input
                id="p-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder={t("phonePlaceholder")}
                dir="ltr"
                maxLength={40}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-email">{t("email")}</Label>
              <Input
                id="p-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                dir="ltr"
                maxLength={200}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p-address">{t("address")}</Label>
            <Input
              id="p-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              maxLength={300}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p-note">{t("note")}</Label>
            <Textarea
              id="p-note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder={t("notePlaceholder")}
              rows={2}
              maxLength={1000}
            />
          </div>
        </div>
      </FormDialog>
    </div>
  );
}

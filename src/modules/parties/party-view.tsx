"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, asRole, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { FormDialog, Pagination, SearchInput } from "@/components/shared/table-kit";
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

  return (
    <div className="space-y-6" data-view={`module:${kind}s`}>
      <PageHeader
        title={typePlural}
        subtitle={t("subtitle", { type: typeLabel })}
        actions={
          writable ? (
            <Button onClick={openCreate} size="sm">
              <Plus className="size-4" aria-hidden="true" />
              {t("add", { type: typeLabel })}
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
          ) : items.length === 0 ? (
            <EmptyState icon={Users} title={tCommon("search")} description={t("searchPlaceholder")} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colName")}</TableHead>
                      <TableHead>{t("colContact")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("colNote")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("colCreated")}</TableHead>
                      {writable ? (
                        <TableHead className="text-end">{tCommon("actions")}</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((p) => {
                      const initials = p.name.slice(0, 2).toUpperCase();
                      return (
                        <TableRow key={p.id} className="hover:bg-muted/40">
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Avatar className="size-8">
                                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                              </Avatar>
                              <span className="font-medium">{p.name}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">
                              {p.phone ? (
                                <p dir="ltr" className="text-start">{p.phone}</p>
                              ) : null}
                              {p.email ? (
                                <p className="text-muted-foreground text-xs" dir="ltr">{p.email}</p>
                              ) : null}
                              {!p.phone && !p.email ? (
                                <span className="text-muted-foreground text-xs">—</span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground hidden max-w-52 truncate text-sm md:table-cell" dir="auto">
                            {p.note ?? "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground hidden whitespace-nowrap text-sm sm:table-cell">
                            {dateFmt.format(new Date(p.createdAt))}
                          </TableCell>
                          {writable ? (
                            <TableCell className="text-end">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                  onClick={() => openEdit(p)}
                                  aria-label={t("edit", { type: typeLabel })}
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
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={page}
                pageSize={10}
                total={total}
                onPage={setPage}
                labels={{ prev: tCommon("previous"), next: tCommon("next"), of: business.locale === "fa" ? "از" : "of" }}
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

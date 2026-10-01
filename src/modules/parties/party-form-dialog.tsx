"use client";

/**
 * Prompt 34 — party (customer/supplier) form dialog, EXTRACTED from
 * party-view so the Customers/Suppliers list and the entity DETAIL pages
 * share ONE edit/create implementation (§25/§26/§75 — no second form).
 * Behavior is identical to the original inline dialog; onSuccess now also
 * invalidates the affected entity detail (§37, targeted).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import { api, ApiClientError } from "@/lib/api-client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormDialog } from "@/components/shared/table-kit";
import { useAppStore } from "@/store/app-store";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import type { EntityType } from "@/lib/entity-routes";
import type { Party } from "./party-view";

const API_BASE = { customer: "/api/v1/customers", supplier: "/api/v1/suppliers" } as const;

type PartyForm = { name: string; phone: string; email: string; address: string; note: string };

function formFrom(p: Party | null): PartyForm {
  return p
    ? { name: p.name, phone: p.phone ?? "", email: p.email ?? "", address: p.address ?? "", note: p.note ?? "" }
    : { name: "", phone: "", email: "", address: "", note: "" };
}

export function PartyFormDialog({
  open,
  onOpenChange,
  kind,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "customer" | "supplier";
  editing: Party | null;
}) {
  const t = useTranslations("parties");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const typeLabel = t(kind);
  const [form, setForm] = useState<PartyForm>(() => formFrom(editing));

  // Render-phase reset when the dialog opens (React-sanctioned adjustment).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setForm(formFrom(editing));
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
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["parties", kind] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      // §37 — the open detail (if any) converges to server state.
      if (editing) {
        invalidateEntityDetail(queryClient, businessId, kind as EntityType, editing.id);
      }
    },
    onError: (err) => {
      toast({
        title: billingErrorText(err) || (err instanceof ApiClientError ? err.message : tErrors("generic")),
        variant: "destructive",
      });
    },
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
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
  );
}

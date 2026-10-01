"use client";

/**
 * Prompt 35 — lead create/edit dialog (§57).
 *
 * Law:
 * - DialogTitle + DialogDescription always render (§57/§95 — the Prompt 34
 *   a11y requirement; Radix stays silent).
 * - EN + FA copy through the crm.lead namespace — no literals (§91).
 * - The form NEVER sets status/conversion fields (§21 — server-owned).
 * - Success invalidation is handled by the shared mutation hooks (§52).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
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
import { FormDialog } from "@/components/shared/table-kit";
import { LEAD_SOURCES, type LeadDTO, type LeadSource } from "@/lib/crm/types";
import { useBusinessMembers, useLeadMutations } from "./crm-api";
import { ApiClientError } from "@/lib/api-client";

type LeadForm = {
  name: string;
  companyName: string;
  phone: string;
  email: string;
  source: LeadSource;
  sourceDetail: string;
  assignedToUserId: string;
  note: string;
};

function formFrom(lead: LeadDTO | null): LeadForm {
  return lead
    ? {
        name: lead.name,
        companyName: lead.companyName ?? "",
        phone: lead.phone ?? "",
        email: lead.email ?? "",
        source: lead.source,
        sourceDetail: lead.sourceDetail ?? "",
        assignedToUserId: lead.assignedTo?.id ?? "",
        note: lead.note ?? "",
      }
    : {
        name: "",
        companyName: "",
        phone: "",
        email: "",
        source: "MANUAL",
        sourceDetail: "",
        assignedToUserId: "",
        note: "",
      };
}

export function LeadFormDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: LeadDTO | null;
}) {
  const t = useTranslations("crm.lead.form");
  const tSource = useTranslations("crm.lead.source");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const { create, update } = useLeadMutations();
  const { data: members } = useBusinessMembers();

  const [form, setForm] = useState<LeadForm>(() => formFrom(editing));
  const [serverError, setServerError] = useState<string | null>(null);

  // Render-phase reset on open (React-sanctioned pattern — same as P34 forms).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setForm(formFrom(editing));
    setServerError(null);
  }

  const valid = form.name.trim().length >= 2;
  const pending = create.isPending || update.isPending;

  function set<K extends keyof LeadForm>(key: K, value: LeadForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || pending) return;
    setServerError(null);
    const body = {
      name: form.name.trim(),
      companyName: form.companyName.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      source: form.source,
      sourceDetail: form.sourceDetail.trim() || null,
      note: form.note.trim() || null,
      assignedToUserId: form.assignedToUserId || null,
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, body });
      } else {
        await create.mutateAsync(body);
      }
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : tErrors("generic"));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("editTitle") : t("addTitle")}
      description={t("description")}
      submitLabel={editing ? tCommon("save") : tCommon("add")}
      cancelLabel={tCommon("cancel")}
      pending={pending}
      disabled={!valid}
      onSubmit={submit}
    >
      <div className="space-y-1.5">
        <Label htmlFor="lead-name">{t("name")}</Label>
        <Input
          id="lead-name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder={t("namePlaceholder")}
          maxLength={120}
          required
          autoFocus
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="lead-company">{t("company")}</Label>
          <Input
            id="lead-company"
            value={form.companyName}
            onChange={(e) => set("companyName", e.target.value)}
            maxLength={160}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-source">{t("source")}</Label>
          <Select value={form.source} onValueChange={(v) => set("source", v as LeadSource)}>
            <SelectTrigger id="lead-source" aria-label={t("source")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAD_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {tSource(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="lead-phone">{t("phone")}</Label>
          <Input
            id="lead-phone"
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+98 21 1234 5678"
            dir="ltr"
            maxLength={40}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-email">{t("email")}</Label>
          <Input
            id="lead-email"
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            dir="ltr"
            maxLength={160}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="lead-source-detail">{t("sourceDetail")}</Label>
          <Input
            id="lead-source-detail"
            value={form.sourceDetail}
            onChange={(e) => set("sourceDetail", e.target.value)}
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-assignee">{t("assignedTo")}</Label>
          <Select
            value={form.assignedToUserId || "unassigned"}
            onValueChange={(v) => set("assignedToUserId", v === "unassigned" ? "" : v)}
          >
            <SelectTrigger id="lead-assignee" aria-label={t("assignedTo")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">{t("unassigned")}</SelectItem>
              {(members ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name ?? m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lead-note">{t("note")}</Label>
        <Textarea
          id="lead-note"
          value={form.note}
          onChange={(e) => set("note", e.target.value)}
          maxLength={2000}
          rows={3}
        />
      </div>
      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
      {pending ? (
        <span className="sr-only">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        </span>
      ) : null}
    </FormDialog>
  );
}

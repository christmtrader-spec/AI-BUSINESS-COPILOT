"use client";

/**
 * Prompt 35 — Lead conversion dialog (§60/§61).
 *
 * Law:
 * - Two EXPLICIT modes only: link an existing tenant customer, or create a
 *   new one (pre-filled from the lead, §25 field mapping).
 * - Optional opportunity creation inside the SAME atomic transaction (§23).
 * - Concise safety confirmation before submit (§61): lead → customer; no
 *   sale, no payment is created — the final transaction is
 *   server-authoritative.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormDialog } from "@/components/shared/table-kit";
import type { LeadDTO } from "@/lib/crm";
import { useConvertLead } from "./crm-api";
import { api } from "@/lib/api-client";
import { ApiClientError } from "@/lib/api-client";

type Mode = "EXISTING_CUSTOMER" | "CREATE_CUSTOMER";

export function LeadConvertDialog({
  open,
  onOpenChange,
  lead,
  customers,
  onConverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadDTO | null;
  /** Optional tenant-safe customer options; fetched when omitted (§80). */
  customers?: { id: string; name: string }[];
  /** Called with the resulting customer id for optional navigation. */
  onConverted?: (customerId: string) => void;
}) {
  const t = useTranslations("crm.lead.convert");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const convert = useConvertLead();

  const [mode, setMode] = useState<Mode>("EXISTING_CUSTOMER");
  const [customerId, setCustomerId] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [withOpportunity, setWithOpportunity] = useState(false);
  const [opportunityTitle, setOpportunityTitle] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [fetchedCustomers, setFetchedCustomers] = useState<{ id: string; name: string }[]>([]);

  // Self-sufficient customer options (id/name only, §80) when the caller
  // did not pass its own list.
  useEffect(() => {
    if (!open || customers) return;
    let cancelled = false;
    void api<{ items: { id: string; name: string }[] }>("/api/v1/customers?pageSize=100")
      .then((res) => {
        if (!cancelled) setFetchedCustomers(res.items);
      })
      .catch(() => {
        if (!cancelled) setFetchedCustomers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, customers]);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setMode("EXISTING_CUSTOMER");
    setCustomerId("");
    setNewName(lead?.name ?? "");
    setNewPhone(lead?.phone ?? "");
    setNewEmail(lead?.email ?? "");
    setWithOpportunity(false);
    setOpportunityTitle("");
    setServerError(null);
  }

  const options = customers ?? fetchedCustomers;
  const valid =
    mode === "EXISTING_CUSTOMER"
      ? customerId !== ""
      : newName.trim().length >= 1;
  const opportunityValid = !withOpportunity || opportunityTitle.trim().length >= 2;
  const pending = convert.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lead || !valid || !opportunityValid || pending) return;
    setServerError(null);
    try {
      const body: Record<string, unknown> = {
        mode,
        ...(mode === "EXISTING_CUSTOMER"
          ? { customerId }
          : {
              customer: {
                name: newName.trim(),
                phone: newPhone.trim() || null,
                email: newEmail.trim() || null,
              },
            }),
        ...(withOpportunity ? { opportunityTitle: opportunityTitle.trim() } : {}),
      };
      const result = (await convert.mutateAsync({ id: lead.id, body })) as {
        customerId?: string;
      };
      onOpenChange(false);
      if (result?.customerId) onConverted?.(result.customerId);
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : tErrors("generic"));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
      submitLabel={t("submit")}
      cancelLabel={tCommon("cancel")}
      pending={pending}
      disabled={!valid || !opportunityValid}
      onSubmit={submit}
    >
      <div className="space-y-1.5">
        <Label htmlFor="convert-mode">{t("mode")}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <SelectTrigger id="convert-mode" aria-label={t("mode")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="EXISTING_CUSTOMER">{t("existingCustomer")}</SelectItem>
            <SelectItem value="CREATE_CUSTOMER">{t("createCustomer")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "EXISTING_CUSTOMER" ? (
        <div className="space-y-1.5">
          <Label htmlFor="convert-customer">{t("customer")}</Label>
          <Select value={customerId || "none"} onValueChange={(v) => setCustomerId(v === "none" ? "" : v)}>
            <SelectTrigger id="convert-customer" aria-label={t("customer")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" disabled>
                {t("selectCustomer")}
              </SelectItem>
              {options.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="convert-new-name">{t("customerName")}</Label>
            <Input
              id="convert-new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={120}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="convert-new-phone">{t("customerPhone")}</Label>
            <Input
              id="convert-new-phone"
              type="tel"
              dir="ltr"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              maxLength={40}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="convert-new-email">{t("customerEmail")}</Label>
            <Input
              id="convert-new-email"
              type="email"
              dir="ltr"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              maxLength={160}
            />
          </div>
        </div>
      )}

      <div className="flex items-start gap-2">
        <Checkbox
          id="convert-with-opp"
          checked={withOpportunity}
          onCheckedChange={(v) => setWithOpportunity(v === true)}
        />
        <div className="grid gap-1">
          <Label htmlFor="convert-with-opp" className="font-normal">
            {t("withOpportunity")}
          </Label>
        </div>
      </div>
      {withOpportunity ? (
        <div className="space-y-1.5">
          <Label htmlFor="convert-opp-title">{t("opportunityTitle")}</Label>
          <Input
            id="convert-opp-title"
            value={opportunityTitle}
            onChange={(e) => setOpportunityTitle(e.target.value)}
            maxLength={160}
            required
          />
        </div>
      ) : null}

      {/* §61 — concise safety confirmation */}
      <div className="bg-muted/60 text-muted-foreground rounded-md border p-3 text-xs leading-relaxed">
        <p>{t("confirmLead")}</p>
        {withOpportunity ? <p>{t("confirmOpportunity")}</p> : null}
        <p>{t("confirmNoFinance")}</p>
      </div>

      {serverError ? (
        <p className="text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
    </FormDialog>
  );
}

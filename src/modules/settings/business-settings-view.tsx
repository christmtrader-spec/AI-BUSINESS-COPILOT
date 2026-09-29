"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Check,
  Coins,
  DatabaseBackup,
  FileJson,
  FolderSync,
  Globe2,
  Loader2,
  Save,
  ScanSearch,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { CURRENCIES, findCurrency } from "@/lib/currencies";
import { formatMoney, toMinor } from "@/lib/money";
import { asRole, can, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import {
  BACKUP_SCHEMA_ID,
  IMPORT_ENTITIES,
  type ImportConflict,
  type ImportReport,
} from "@/lib/backup-schema";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/primitives";
import type { BusinessSummary } from "../shell/types";

const FALLBACK_TIMEZONES = ["UTC", "Asia/Tehran", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];

function timezoneOptions(): string[] {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {
    // older engines
  }
  return FALLBACK_TIMEZONES;
}

export function BusinessSettingsView({ business }: { business: BusinessSummary }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const activeId = useAppStore((s) => s.activeBusinessId);

  const { data: fresh } = useQuery<BusinessSummary>({
    queryKey: ["business", activeId],
    queryFn: () => api(`/api/v1/businesses/${activeId}`),
  });
  const current = fresh ?? business;

  const zones = useMemo(() => timezoneOptions(), []);
  const [name, setName] = useState(current.name);
  const [currencyCode, setCurrencyCode] = useState(current.currencyCode);
  const [symbol, setSymbol] = useState(current.currencySymbol);
  const [precision, setPrecision] = useState(current.decimalPrecision);
  const [locale, setLocale] = useState<"en" | "fa">(
    current.locale === "fa" ? "fa" : "en",
  );
  const [timezone, setTimezone] = useState(current.timezone);
  const [syncedKey, setSyncedKey] = useState(current.id + current.updatedAt);
  // React "adjust state during render" pattern — avoids setState-in-effect.
  const currentKey = current.id + current.updatedAt;
  if (currentKey !== syncedKey) {
    setSyncedKey(currentKey);
    setName(current.name);
    setCurrencyCode(current.currencyCode);
    setSymbol(current.currencySymbol);
    setPrecision(current.decimalPrecision);
    setLocale(current.locale === "fa" ? "fa" : "en");
    setTimezone(current.timezone);
  }

  // We read the role from the cached memberships list (AppRoot query).
  const { data: memberships } = useQuery<{ role: string }[]>({
    queryKey: ["businesses"],
    queryFn: () => api("/api/v1/businesses", { businessId: null }),
    staleTime: 60_000,
    enabled: false,
  });
  const role: Role = asRole(
    memberships?.find((m) => (m as { business?: { id?: string } }).business?.id === activeId)?.role,
  );
  const editable = can(role, "settings:manage");

  const saveMutation = useMutation({
    mutationFn: async () =>
      api<BusinessSummary>(`/api/v1/businesses/${activeId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          currencyCode,
          currencySymbol: symbol,
          decimalPrecision: precision,
          locale,
          timezone,
        }),
      }),
    onSuccess: () => {
      toast({ title: t("savedToast") });
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      void queryClient.invalidateQueries({ queryKey: ["business"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("saveError"),
        variant: "destructive",
      });
    },
  });

  const preview = useMemo(() => {
    try {
      return formatMoney(toMinor("1234.5", precision), {
        currencyCode,
        currencySymbol: symbol,
        decimalPrecision: precision,
        locale,
      });
    } catch {
      return "—";
    }
  }, [precision, currencyCode, symbol, locale]);

  const [exporting, setExporting] = useState(false);

  async function exportData() {
    setExporting(true);
    try {
      const res = await fetch(`/api/v1/businesses/${activeId}/export`, {
        credentials: "same-origin",
        headers: activeId ? { "x-business-id": activeId } : undefined,
      });
      if (!res.ok) {
        let message = t("exportError");
        try {
          const body = (await res.json()) as {
            error?: { message?: string; code?: string };
          };
          if (body.error?.code === "RATE_LIMITED") message = t("exportRateLimited");
          else if (body.error?.message) message = body.error.message;
        } catch {
          // keep default
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dispo = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(dispo);
      a.download = match?.[1] ?? `backup-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: t("exportedToast") });
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("exportError"),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  }

  // ---- Restore from backup (OWNER-only) ------------------------------------
  const isOwner = role === "OWNER";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoreFile, setRestoreFile] = useState<{
    name: string;
    size: number;
    body: unknown;
    currencyCode: string;
  } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState<"dry_run" | "merge" | null>(null);
  const [restoreReport, setRestoreReport] = useState<ImportReport | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoreIdMode, setRestoreIdMode] = useState<"keep" | "new">("keep");

  // ---- Danger zone (OWNER-only): permanent business deletion ----------------
  const [dangerOpen, setDangerOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  type DangerCounts = {
    customers: number;
    suppliers: number;
    products: number;
    sales: number;
    expenses: number;
    payments: number;
  };
  const { data: dangerCounts, isLoading: countsLoading } = useQuery<DangerCounts>({
    queryKey: ["business", activeId, "danger"],
    queryFn: () => api(`/api/v1/businesses/${activeId}/danger`),
    enabled: dangerOpen && isOwner,
    staleTime: 0,
  });

  const deleteBusiness = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/businesses/${activeId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(activeId ? { "x-business-id": activeId } : {}),
        },
        body: JSON.stringify({ confirmName: confirmText }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { code?: string };
      } | null;
      if (!res.ok || !body?.ok) {
        if (body?.error?.code === "CONFIRM_MISMATCH") throw new Error(t("dangerMismatch"));
        if (body?.error?.code === "RATE_LIMITED") throw new Error(t("exportRateLimited"));
        throw new Error(t("dangerDeleteFailed"));
      }
      return true;
    },
    onSuccess: () => {
      toast({ title: t("dangerDeletedToast") });
      setDangerOpen(false);
      // Everything this business owned is gone — drop all cached queries so
      // no view can flash stale tenant data; AppRoot switches to another
      // business (or onboarding) once the memberships list refetches.
      void queryClient.invalidateQueries();
      useAppStore.getState().navigate({ kind: "dashboard" }, { replace: true });
    },
    onError: (err) =>
      toast({
        title: err instanceof Error ? err.message : t("dangerDeleteFailed"),
        variant: "destructive",
      }),
  });

  const nameMatches = confirmText === current.name;

  const resetRestore = () => {
    setRestoreFile(null);
    setRestoreReport(null);
    setRestoreError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  async function onRestoreFileChange(file: File | undefined) {
    setRestoreReport(null);
    setRestoreError(null);
    if (!file) {
      setRestoreFile(null);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setRestoreFile(null);
      setRestoreError(t("restoreFileError"));
      return;
    }
    try {
      const text = await file.text();
      const json = JSON.parse(text) as {
        $schema?: string;
        business?: { currencyCode?: string };
      };
      if (json?.$schema !== BACKUP_SCHEMA_ID) {
        setRestoreFile(null);
        setRestoreError(t("restoreInvalidFile"));
        return;
      }
      setRestoreFile({
        name: file.name,
        size: file.size,
        body: json,
        currencyCode: json.business?.currencyCode ?? "?",
      });
    } catch {
      setRestoreFile(null);
      setRestoreError(t("restoreInvalidFile"));
    }
  }

  async function runRestore(mode: "dry_run" | "merge") {
    if (!restoreFile || !activeId) return;
    setRestoreBusy(mode);
    setRestoreError(null);
    try {
      const res = await fetch(
        `/api/v1/businesses/${activeId}/import?mode=${mode}&ids=${restoreIdMode}`,
        {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(activeId ? { "x-business-id": activeId } : {}),
        },
        body: JSON.stringify(restoreFile.body),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        data?: { report: ImportReport };
        error?: { code?: string; message?: string };
      };
      if (!res.ok || !body?.ok || !body.data) {
        setRestoreReport(null);
        if (body?.error?.code === "INVALID_BACKUP") setRestoreError(t("restoreInvalidFile"));
        else if (body?.error?.code === "PERMISSION_DENIED") setRestoreError(t("restoreOwnerOnly"));
        else if (body?.error?.code === "RATE_LIMITED") setRestoreError(t("exportRateLimited"));
        else setRestoreError(t("restoreFailed"));
        return;
      }
      setRestoreReport(body.data.report);
      if (mode === "merge") {
        toast({ title: t("restoreDone") });
        void queryClient.invalidateQueries();
        resetRestore();
      }
    } catch {
      setRestoreError(t("restoreFailed"));
    } finally {
      setRestoreBusy(null);
      setConfirmOpen(false);
    }
  }

  const entityLabelKey: Record<(typeof IMPORT_ENTITIES)[number], string> = {
    customers: "entityCustomers",
    suppliers: "entitySuppliers",
    products: "entityProducts",
    inventoryAdjustments: "entityAdjustments",
    sales: "entitySales",
    expenses: "entityExpenses",
    payments: "entityPayments",
  };

  function renderConflict(c: ImportConflict) {
    return (
      <li key={`${c.entity}-${c.reason}-${c.ref}`} className="flex items-start gap-1.5">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span dir="ltr">
          <span className="font-medium">{c.ref}</span> — {t(`restoreReason_${c.reason}` as "restoreReason_DUPLICATE_ID")}
        </span>
      </li>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-view="settings:business">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (editable) saveMutation.mutate();
        }}
        className="space-y-4"
        noValidate
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="text-primary size-4" aria-hidden="true" />
              {t("sectionGeneral")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="set-name">{t("businessName")}</Label>
              <Input
                id="set-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!editable}
                maxLength={120}
                required
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Coins className="text-primary size-4" aria-hidden="true" />
              {t("sectionCurrency")}
            </CardTitle>
            <CardDescription>{t("currencyHint")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="set-currency">{t("currency")}</Label>
              <Select
                value={currencyCode}
                onValueChange={(v) => {
                  setCurrencyCode(v);
                  const c = findCurrency(v);
                  if (c) {
                    setSymbol(c.symbol);
                    setPrecision(c.precision);
                  }
                }}
                disabled={!editable}
              >
                <SelectTrigger id="set-currency" dir="ltr" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} · {c.symbol} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-symbol">{t("symbol")}</Label>
              <Input
                id="set-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={!editable}
                dir="ltr"
                maxLength={8}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-precision">{t("precision")}</Label>
              <Select
                value={String(precision)}
                onValueChange={(v) => setPrecision(Number(v))}
                disabled={!editable}
              >
                <SelectTrigger id="set-precision" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="bg-muted/40 sm:col-span-3 flex items-center justify-between rounded-lg border px-4 py-3">
              <span className="text-sm font-medium">{t("preview")}</span>
              <span className="bg-background rounded-md border px-3 py-1.5 text-sm font-semibold tabular-nums">
                {preview}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe2 className="text-primary size-4" aria-hidden="true" />
              {t("sectionLocale")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="set-locale">{t("locale")}</Label>
              <Select value={locale} onValueChange={(v) => setLocale(v as "en" | "fa")} disabled={!editable}>
                <SelectTrigger id="set-locale" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English (LTR)</SelectItem>
                  <SelectItem value="fa">فارسی (RTL)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-timezone">{t("timezone")}</Label>
              <Select value={timezone} onValueChange={setTimezone} disabled={!editable}>
                <SelectTrigger id="set-timezone" dir="ltr" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {zones.map((z) => (
                    <SelectItem key={z} value={z}>
                      {z}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Separator />

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={!editable || saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            {saveMutation.isPending ? tCommon("saving") : tCommon("save")}
          </Button>
        </div>
      </form>

      {editable ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <DatabaseBackup className="text-primary size-4" aria-hidden="true" />
              {t("dataSection")}
            </CardTitle>
            <CardDescription>{t("dataSectionDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-muted-foreground grid gap-2 text-xs sm:grid-cols-2">
              <p className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t("dataIncludes1")}
              </p>
              <p className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t("dataIncludes2")}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-4 py-3">
              <p className="text-muted-foreground text-xs">{t("dataNote")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void exportData()}
                disabled={exporting}
              >
                {exporting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <DatabaseBackup className="size-4" aria-hidden="true" />
                )}
                {exporting ? t("exporting") : t("exportAction")}
              </Button>
            </div>
            {/* Prompt 31 §186 — Business Settings links to the Data Portability
                center. The operator backup above stays a separate story (§130:
                backup = system recovery artifact; export = portable dataset). */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("dataPortabilityTitle")}</p>
                <p className="text-muted-foreground text-xs">{t("dataPortabilityDesc")}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => useAppStore.getState().navigate({ kind: "settings:data" })}>
                <FolderSync className="size-4" aria-hidden="true" />
                {t("dataPortabilityAction")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UploadCloud className="text-primary size-4" aria-hidden="true" />
              {t("restoreSection")}
            </CardTitle>
            <CardDescription>{t("restoreSectionDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* File picker */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed bg-muted/30 px-4 py-4">
              <div
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-lg border",
                  restoreFile ? "border-emerald-500/30 bg-emerald-500/10" : "bg-background",
                )}
                aria-hidden="true"
              >
                {restoreFile ? (
                  <FileJson className="size-5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <FileJson className="text-muted-foreground size-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" dir="auto">
                  {restoreFile ? restoreFile.name : t("restoreFileHint")}
                </p>
                {restoreFile ? (
                  <p className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                    {(restoreFile.size / 1024).toFixed(1)} KB
                  </p>
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                id="restore-file-input"
                onChange={(e) => void onRestoreFileChange(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => fileInputRef.current?.click()}
              >
                {restoreFile ? t("restoreChangeFile") : t("restoreChooseFile")}
              </Button>
            </div>

            {restoreError ? (
              <div
                className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm"
                role="alert"
              >
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{restoreError}</span>
              </div>
            ) : null}

            {/* ID handling mode */}
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("restoreIdMode")}>
              {(
                [
                  { value: "keep", label: t("restoreIdKeep"), hint: t("restoreIdKeepHint") },
                  { value: "new", label: t("restoreIdNew"), hint: t("restoreIdNewHint") },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={restoreIdMode === opt.value}
                  onClick={() => {
                    setRestoreIdMode(opt.value);
                    setRestoreReport(null);
                  }}
                  className={cn(
                    "rounded-lg border p-3 text-start transition-colors",
                    restoreIdMode === opt.value
                      ? "border-primary bg-primary/5 ring-primary/20 ring-1"
                      : "hover:bg-muted/40 border-border",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        restoreIdMode === opt.value ? "border-primary" : "border-muted-foreground/40",
                      )}
                      aria-hidden="true"
                    >
                      {restoreIdMode === opt.value ? (
                        <span className="bg-primary size-2 rounded-full" />
                      ) : null}
                    </span>
                    {opt.label}
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs">{opt.hint}</span>
                </button>
              ))}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-4 py-3">
              <p className="text-muted-foreground max-w-md text-xs">{t("restoreIgnoredNote")}</p>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void runRestore("dry_run")}
                  disabled={!restoreFile || restoreBusy !== null}
                >
                  {restoreBusy === "dry_run" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ScanSearch className="size-4" aria-hidden="true" />
                  )}
                  {restoreBusy === "dry_run" ? t("restoreAnalyzing") : t("restoreAnalyze")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={!restoreReport || restoreReport.mode !== "dry_run" || restoreBusy !== null || restoreReport.wouldCreate === 0}
                >
                  {restoreBusy === "merge" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <UploadCloud className="size-4" aria-hidden="true" />
                  )}
                  {restoreBusy === "merge" ? t("restoreImporting") : t("restoreImport")}
                </Button>
              </div>
            </div>

            {/* Analysis report */}
            {restoreReport ? (
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{t("restoreReportTitle")}</p>
                    {restoreReport.exportedAt ? (
                      <p className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                        {new Date(restoreReport.exportedAt).toLocaleString(locale === "fa" ? "fa-IR" : "en-GB", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </p>
                    ) : null}
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      restoreReport.mode === "dry_run"
                        ? "border-border text-muted-foreground bg-muted/40"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    }
                  >
                    {restoreReport.mode === "dry_run"
                      ? t("restoreReportWouldCreate", { count: restoreReport.wouldCreate })
                      : t("restoreReportCreated", { count: restoreReport.created })}
                  </Badge>
                </div>

                {!restoreReport.businessMatch ? (
                  <p className="text-amber-700 dark:text-amber-400 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {t("restoreBusinessMismatch")}
                  </p>
                ) : null}
                {!restoreReport.currencyMatch ? (
                  <p className="text-amber-700 dark:text-amber-400 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {t("restoreCurrencyMismatch", {
                      backup: restoreFile?.currencyCode ?? "?",
                      current: current.currencyCode,
                    })}
                  </p>
                ) : null}

                <ul className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
                  {IMPORT_ENTITIES.map((entity) => {
                    const r = restoreReport.entities[entity];
                    return (
                      <li
                        key={entity}
                        className="bg-muted/40 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                      >
                        <span className="font-medium">{t(entityLabelKey[entity] as "entityCustomers")}</span>
                        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                          {r.toCreate > 0 ? (
                            <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                              +{r.toCreate} {t("restoreNew")}
                            </Badge>
                          ) : null}
                          {r.existing > 0 ? (
                            <Badge variant="outline" className="text-muted-foreground h-5 px-1.5 text-[10px]">
                              {r.existing} {t("restoreExisting")}
                            </Badge>
                          ) : null}
                          {r.invalid > 0 ? (
                            <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                              {r.invalid} {t("restoreSkipped")}
                            </Badge>
                          ) : null}
                          {r.total === 0 ? (
                            <span className="text-muted-foreground text-[10px]">—</span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                {restoreReport.conflicts.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold">
                      {t("restoreConflicts")} ({restoreReport.conflicts.length})
                    </p>
                    <ul className="space-y-1 text-xs">
                      {restoreReport.conflicts.slice(0, 12).map(renderConflict)}
                    </ul>
                    {restoreReport.conflicts.length > 12 ? (
                      <p className="text-muted-foreground text-[11px] tabular-nums" dir="ltr">
                        +{restoreReport.conflicts.length - 12}…
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-xs">
            <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("restoreOwnerOnly")}
          </CardContent>
        </Card>
      )}

      {/* Import confirmation */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restoreConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("restoreConfirmDesc", {
                count: restoreReport?.wouldCreate ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runRestore("merge")}>
              {restoreBusy === "merge" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <UploadCloud className="size-4" aria-hidden="true" />
              )}
              {t("restoreConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Danger zone (OWNER-only) ---- */}
      {isOwner ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2 text-base">
              <ShieldAlert className="size-4" aria-hidden="true" />
              {t("dangerSection")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">{t("dangerDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="destructive"
              className="gap-2"
              onClick={() => {
                setConfirmText("");
                setDangerOpen(true);
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t("dangerDeleteAction")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Delete confirmation — typed name + live record counts */}
      <AlertDialog
        open={dangerOpen}
        onOpenChange={(open) => {
          setDangerOpen(open);
          if (!open) {
            setConfirmText("");
            deleteBusiness.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dangerDialogTitle", { name: current.name })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {countsLoading || !dangerCounts
                    ? t("dangerLoadingCounts")
                    : t("dangerDialogDesc", {
                        customers: dangerCounts.customers,
                        suppliers: dangerCounts.suppliers,
                        products: dangerCounts.products,
                        sales: dangerCounts.sales,
                        expenses: dangerCounts.expenses,
                        payments: dangerCounts.payments,
                      })}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  {t("dangerDialogExportHint")}
                  <button
                    type="button"
                    onClick={() => void exportData()}
                    className="text-foreground inline-flex items-center gap-1 font-medium underline underline-offset-2"
                  >
                    <DatabaseBackup className="size-3.5" aria-hidden="true" />
                    {t("dangerDialogExportNow")}
                  </button>
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="danger-confirm">{t("dangerTypePrompt", { name: current.name })}</Label>
            <Input
              id="danger-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              maxLength={120}
            />
            {confirmText.length > 0 && !nameMatches ? (
              <p className="text-destructive text-xs">{t("dangerMismatch")}</p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              disabled={!nameMatches || deleteBusiness.isPending}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the DELETE resolves
                deleteBusiness.mutate();
              }}
            >
              {deleteBusiness.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              {t("dangerConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

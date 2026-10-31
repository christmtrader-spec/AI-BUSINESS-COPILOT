"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { IMPORT_FIELDS, IMPORT_DATASET_KEYS, type ImportDatasetKey } from "@/lib/data-portability/import-fields";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, CloudUpload, Download, Loader2, ShieldCheck } from "lucide-react";

type ImportJobDTO = {
  id: string;
  datasetType: ImportDatasetKey;
  status: string;
  fileName: string;
  fileSize: number;
  rowCount: number | null;
  validRows: number | null;
  invalidRows: number | null;
  duplicateRows: number | null;
  wouldCreate: number | null;
  wouldSkip: number | null;
  createdCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
  errorsTruncated: boolean;
  topErrors: Array<{ rowNumber: number; field: string | null; code: string }>;
  failureCode: string | null;
  createdAt: string;
};

type UploadResult = {
  job: ImportJobDTO;
  detectedColumns: string[];
  suggestedMapping: Record<string, string>;
};

type WizardStep = "dataset" | "upload" | "mapping" | "validate" | "review" | "commit" | "result";

const STEP_ORDER: WizardStep[] = ["dataset", "upload", "mapping", "validate", "review", "commit", "result"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImportPanel() {
  const t = useTranslations("portability");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const activeId = useAppStore((s) => s.activeBusinessId);

  const [step, setStep] = useState<WizardStep>("dataset");
  const [dataset, setDataset] = useState<ImportDatasetKey>("customers");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<"SKIP" | "REJECT">("SKIP");
  // target field -> source column ("" = unmapped)
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [commitResult, setCommitResult] = useState<ImportJobDTO | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Local validation-summary state (from validate/dry-run endpoints).
  const [counts, setCounts] = useState<{ total: number; valid: number; invalid: number; duplicates: number; wouldCreate: number; wouldSkip: number } | null>(null);

  const historyQuery = useQuery<{ items: ImportJobDTO[]; total: number }>({
    queryKey: ["portability-imports", activeId],
    queryFn: () => api("/api/v1/imports?page=1&pageSize=10"),
  });

  function requiredFieldsMissing(): boolean {
    return IMPORT_FIELDS[dataset].some((f) => f.required && !mapping[f.name]);
  }

  const reset = () => {
    setStep("dataset");
    setUpload(null);
    setFileMeta(null);
    setMapping({});
    setCounts(null);
    setCommitResult(null);
    setDuplicateMode("SKIP");
  };

  const applySuggested = (result: UploadResult) => {
    const next: Record<string, string> = {};
    for (const field of IMPORT_FIELDS[result.job.datasetType]) {
      const hit = Object.entries(result.suggestedMapping).find(([, target]) => target === field.name);
      next[field.name] = hit ? hit[0] : "";
    }
    return next;
  };

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("dataset", dataset);
      form.append("file", file);
      // Multipart upload — no content-type header (the browser sets it).
      const res = await fetch("/api/v1/imports", {
        method: "POST",
        credentials: "same-origin",
        headers: activeId ? { "x-business-id": activeId } : undefined,
        body: form,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        const code = body?.error?.code ?? "HTTP_ERROR";
        throw new ApiClientError(code, body?.error?.message ?? "upload failed", res.status);
      }
      return body.data as UploadResult;
    },
    onSuccess: (result) => {
      setUpload(result);
      setMapping(applySuggested(result));
      setFileMeta({ name: result.job.fileName, size: result.job.fileSize });
      setStep("mapping");
      queryClient.invalidateQueries({ queryKey: ["portability-imports"] });
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === "IMPORT_TOO_LARGE") toast.error(t("fileTooLarge"));
      else if (error instanceof ApiClientError && error.code === "IMPORT_INVALID_FILE") toast.error(t("invalidFileType"));
      else toast.error(t("uploadFailed"));
    },
  });

  const mappingMutation = useMutation({
    mutationFn: async () => {
      // API shape: { sourceColumn -> targetField } (§88).
      const apiMapping: Record<string, string> = {};
      for (const [field, column] of Object.entries(mapping)) {
        if (column) apiMapping[column] = field;
      }
      return api<ImportJobDTO>(`/api/v1/imports/${upload!.job.id}/mapping`, {
        method: "POST",
        body: JSON.stringify({ mapping: apiMapping, duplicateMode }),
      });
    },
    onSuccess: () => {
      setStep("validate");
    },
    onError: () => toast.error(t("uploadFailed")),
  });

  const validateMutation = useMutation({
    mutationFn: () =>
      api<{ job: ImportJobDTO }>(`/api/v1/imports/${upload!.job.id}/validate`, { method: "POST" }),
    onSuccess: (result) => {
      setCounts({
        total: result.job.rowCount ?? 0,
        valid: result.job.validRows ?? 0,
        invalid: result.job.invalidRows ?? 0,
        duplicates: result.job.duplicateRows ?? 0,
        wouldCreate: result.job.wouldCreate ?? 0,
        wouldSkip: result.job.wouldSkip ?? 0,
      });
      setStep("review");
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === "IMPORT_VALIDATION_FAILED") {
        // All rows invalid — fetch the job state so the user sees the errors.
        setCounts(null);
        setStep("mapping");
      }
      toast.error(t("uploadFailed"));
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: () =>
      api<{ job: ImportJobDTO; wouldCreate: number; wouldSkip: number; duplicateRows: number }>(`/api/v1/imports/${upload!.job.id}/dry-run`, { method: "POST" }),
    onSuccess: (result) => {
      setCounts((prev) => ({
        total: result.job.rowCount ?? prev?.total ?? 0,
        valid: result.job.validRows ?? prev?.valid ?? 0,
        invalid: result.job.invalidRows ?? prev?.invalid ?? 0,
        duplicates: result.duplicateRows,
        wouldCreate: result.wouldCreate,
        wouldSkip: result.wouldSkip,
      }));
      setStep("commit");
    },
    onError: () => toast.error(t("uploadFailed")),
  });

  // ---- Step-up + commit (§93/§281) ----------------------------------------
  const [reauthOpen, setReauthOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [reauthBusy, setReauthBusy] = useState(false);

  const commitMutation = useMutation({
    mutationFn: async () => {
      // 1) Step-up reauth (recent password + MFA when enabled, §93).
      const reauthRes = await fetch("/api/v1/me/security/reauth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(activeId ? { "x-business-id": activeId } : {}) },
        body: JSON.stringify({ password, ...(mfaCode ? { mfaCode } : {}) }),
      });
      if (!reauthRes.ok) {
        const errBody = await reauthRes.json().catch(() => null);
        const code = errBody?.error?.code ?? "REAUTH_FAILED";
        if (code === "MFA_CODE_REQUIRED") {
          throw new ApiClientError("MFA_CODE_REQUIRED", "mfa required", reauthRes.status);
        }
        throw new ApiClientError("STEP_UP_FAILED", "reauth failed", reauthRes.status);
      }
      // 2) Commit with typed confirmation (§92 — never just "OK").
      return api<{ job: ImportJobDTO; created: number; skipped: number; failed: number; total: number }>(
        `/api/v1/imports/${upload!.job.id}/commit`,
        { method: "POST", body: JSON.stringify({ confirmation: "IMPORT DATA" }) },
      );
    },
    onSuccess: (result) => {
      setCommitResult(result.job);
      setCounts((prev) => (prev ? { ...prev, wouldCreate: result.created, wouldSkip: result.skipped } : prev));
      setReauthOpen(false);
      setPassword("");
      setMfaCode("");
      setConfirmText("");
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["portability-imports"] });
    },
    onError: (error) => {
      setReauthOpen(false);
      if (error instanceof ApiClientError && error.code === "MFA_CODE_REQUIRED") {
        toast.error(t("mfaCode"));
      } else if (error instanceof ApiClientError && error.code === "STEP_UP_FAILED") {
        toast.error(t("reauthFailed"));
      } else {
        toast.error(t("uploadFailed"));
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api(`/api/v1/imports/${jobId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("importCanceledToast"));
      queryClient.invalidateQueries({ queryKey: ["portability-imports"] });
      reset();
    },
    onError: () => toast.error(t("uploadFailed")),
  });

  function onFileChosen(file: File | null | undefined) {
    if (!file) return;
    setFileMeta({ name: file.name, size: file.size });
    uploadMutation.mutate(file);
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const columns = upload?.detectedColumns ?? [];
  const fields = useMemo(() => IMPORT_FIELDS[dataset], [dataset]);

  const commitCounts = counts;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("importTitle")}</CardTitle>
          <CardDescription>{t("importDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Progress — honest states only, never a fake percentage (§197). */}
          <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={t("step", { current: stepIndex + 1, total: STEP_ORDER.length })}>
            {STEP_ORDER.map((s, i) => (
              <li key={s} className="flex items-center gap-1.5">
                <span
                  className={`rounded-full px-2 py-1 ${
                    i === stepIndex
                      ? "bg-primary text-primary-foreground font-medium"
                      : i < stepIndex
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {t(`steps.${s}` as "steps.dataset")}
                </span>
                {i < STEP_ORDER.length - 1 ? <span aria-hidden="true" className="text-muted-foreground">›</span> : null}
              </li>
            ))}
          </ol>

          {step === "dataset" ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">{t("chooseDataset")}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {IMPORT_DATASET_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setDataset(key);
                      setStep("upload");
                    }}
                    className={`hover:bg-accent/50 rounded-lg border p-4 text-start transition-colors motion-reduce:transition-none ${
                      dataset === key ? "border-primary" : ""
                    }`}
                  >
                    <span className="block text-sm font-medium">{t(`dataset${key.charAt(0).toUpperCase()}${key.slice(1)}` as "datasetCustomers")}</span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {t(`dataset${key.charAt(0).toUpperCase()}${key.slice(1)}Desc` as "datasetCustomersDesc")}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">{t("financialNote")}</p>
            </div>
          ) : null}

          {step === "upload" ? (
            <div className="space-y-4">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onFileChosen(e.dataTransfer.files?.[0]);
                }}
                className="hover:bg-accent/30 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center"
              >
                <CloudUpload className="text-muted-foreground size-8" aria-hidden="true" />
                <p className="text-muted-foreground text-sm">
                  {t("dropZone")}{" "}
                  <button type="button" className="text-primary underline underline-offset-4" onClick={() => fileInputRef.current?.click()}>
                    {t("browseFiles")}
                  </button>
                </p>
                <p className="text-muted-foreground text-xs">{t("uploadDesc", { size: "10 MB" })}</p>
                {/* §194 — the drop zone always has a keyboard-accessible Browse Files button. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  className="sr-only"
                  onChange={(e) => onFileChosen(e.target.files?.[0])}
                />
              </div>
              {fileMeta ? (
                <p className="text-sm">
                  {t("fileSelected")}: <span className="font-mono">{fileMeta.name}</span> ({formatBytes(fileMeta.size)})
                </p>
              ) : null}
              {uploadMutation.isPending ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" /> {tCommon("loading")}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep("dataset")}>
                  {tCommon("cancel")}
                </Button>
              </div>
            </div>
          ) : null}

          {step === "mapping" && upload ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">{t("mappingTitle")}</p>
                <p className="text-muted-foreground text-sm">{t("mappingDesc")}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("detected", { rows: upload.job.rowCount ?? 0, columns: columns.length })}
                </p>
              </div>
              <div className="max-h-96 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("targetField")}</TableHead>
                      <TableHead>{t("sourceColumn")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field) => (
                      <TableRow key={field.name}>
                        <TableCell>
                          <span className="text-sm font-medium">{t(`importFields.${field.descriptionKey}` as "importFields.name")}</span>
                          {field.required ? (
                            <Badge variant="secondary" className="ms-2 text-[10px]">
                              {t("required")}
                            </Badge>
                          ) : null}
                          <span className="text-muted-foreground ms-2 block font-mono text-[10px]">{field.name}</span>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={mapping[field.name] ?? ""}
                            onValueChange={(v) => setMapping((prev) => ({ ...prev, [field.name]: v === "__none" ? "" : v }))}
                          >
                            <SelectTrigger className="w-full sm:w-64" aria-label={`${t("sourceColumn")}: ${field.name}`}>
                              <SelectValue placeholder={t("notMapped")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none">{t("notMapped")}</SelectItem>
                              {columns.map((col) => (
                                <SelectItem key={col} value={col}>
                                  {col}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("duplicateMode")}</legend>
                <RadioGroup value={duplicateMode} onValueChange={(v) => setDuplicateMode(v as "SKIP" | "REJECT")} className="grid gap-2 sm:grid-cols-2">
                  <Label htmlFor="dup-skip" className="hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                    <RadioGroupItem id="dup-skip" value="SKIP" className="mt-0.5" />
                    <span>
                      <span className="block text-sm">{t("duplicateSkip")}</span>
                      <span className="text-muted-foreground block text-xs">{t("duplicateSkipDesc")}</span>
                    </span>
                  </Label>
                  <Label htmlFor="dup-reject" className="hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                    <RadioGroupItem id="dup-reject" value="REJECT" className="mt-0.5" />
                    <span>
                      <span className="block text-sm">{t("duplicateReject")}</span>
                      <span className="text-muted-foreground block text-xs">{t("duplicateRejectDesc")}</span>
                    </span>
                  </Label>
                </RadioGroup>
              </fieldset>

              {requiredFieldsMissing() ? <p className="text-destructive text-sm">{t("mappingRequiredError")}</p> : null}

              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep("upload")}>
                  {tCommon("previous")}
                </Button>
                <Button onClick={() => mappingMutation.mutate()} disabled={mappingMutation.isPending || requiredFieldsMissing()}>
                  {mappingMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {t("validateAction")}
                </Button>
                <Button variant="ghost" onClick={reset} className="ms-auto">
                  {t("cancelImport")}
                </Button>
              </div>
            </div>
          ) : null}

          {step === "validate" && upload ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">{t("validateAction")}</p>
              <p className="text-muted-foreground text-sm">{t("validationResults")}</p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep("mapping")}>
                  {tCommon("previous")}
                </Button>
                <Button onClick={() => validateMutation.mutate()} disabled={validateMutation.isPending}>
                  {validateMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {validateMutation.isPending ? t("validating") : t("validateAction")}
                </Button>
              </div>
            </div>
          ) : null}

          {step === "review" && upload ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">{t("validationResults")}</p>
                <p className="text-muted-foreground text-sm">{t("dryRunNote")}</p>
              </div>
              {counts ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <CountBox label={t("totalRows")} value={counts.total} />
                  <CountBox label={t("validRows")} value={counts.valid} tone="ok" />
                  <CountBox label={t("invalidRows")} value={counts.invalid} tone="bad" />
                  <CountBox label={t("duplicates")} value={counts.duplicates} tone="warn" />
                  <CountBox label={t("wouldCreate")} value={counts.wouldCreate} tone="ok" />
                </div>
              ) : null}
              {upload.job.topErrors.length > 0 ? (
                <div className="rounded-lg border p-3">
                  <p className="text-sm font-medium">{t("topErrors")}</p>
                  <ul className="mt-2 space-y-1">
                    {upload.job.topErrors.map((err, idx) => (
                      <li key={`${err.rowNumber}-${idx}`} className="text-destructive text-xs">
                        #{err.rowNumber} · {err.code}
                        {err.field ? ` · ${err.field}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {counts && counts.invalid > 0 ? (
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/v1/imports/${upload.job.id}/errors`, { credentials: "same-origin" });
                      if (!res.ok) throw new Error("failed");
                      const blob = await res.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `import-errors-${upload.job.datasetType}.csv`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    } catch {
                      toast.error(t("downloadFailed"));
                    }
                  }}
                >
                  <Download className="size-4" aria-hidden="true" />
                  {t("downloadErrorReport")}
                </Button>
              ) : null}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep("mapping")}>
                  {tCommon("previous")}
                </Button>
                <Button onClick={() => dryRunMutation.mutate()} disabled={dryRunMutation.isPending || !counts || counts.valid === 0}>
                  {dryRunMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {t("dryRunAction")}
                </Button>
              </div>
            </div>
          ) : null}

          {step === "commit" && upload ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  {t("commitWarning")}
                </p>
                <p className="text-muted-foreground mt-1 text-sm">{t("commitWarningDesc")}</p>
                {commitCounts ? (
                  <ul className="mt-3 space-y-1 text-sm">
                    <li>{t("createCount", { count: commitCounts.wouldCreate })}</li>
                    <li>{t("skipCount", { count: commitCounts.wouldSkip })}</li>
                    {commitCounts.invalid > 0 ? <li className="text-destructive">{t("errorCount", { count: commitCounts.invalid })}</li> : null}
                  </ul>
                ) : null}
                <p className="text-muted-foreground mt-3 text-xs">{t("dryRunResults")}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep("review")}>
                  {tCommon("previous")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={!!commitCounts && (commitCounts.wouldCreate === 0 || commitCounts.invalid > 0)}
                  onClick={() => setReauthOpen(true)}
                >
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  {t("commitAction")}
                </Button>
              </div>
              {counts && counts.wouldCreate === 0 ? <p className="text-muted-foreground text-xs">{t("skipCount", { count: counts.wouldSkip })}</p> : null}
            </div>
          ) : null}

          {step === "result" && commitResult ? (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                {t("resultTitle")}
              </p>
              <div className="grid grid-cols-3 gap-3">
                <CountBox label={t("resultCreated", { count: "" })} value={commitResult.createdCount ?? 0} tone="ok" />
                <CountBox label={t("resultSkipped", { count: "" })} value={commitResult.skippedCount ?? 0} tone="warn" />
                <CountBox label={t("resultFailed", { count: "" })} value={commitResult.failedCount ?? 0} tone="bad" />
              </div>
              <div className="flex gap-2">
                <Button onClick={reset}>{t("importAnother")}</Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Step-up reauth dialog (inline card) — §93/§279 */}
      {reauthOpen ? (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4" aria-hidden="true" />
              {t("reauthTitle")}
            </CardTitle>
            <CardDescription>{t("reauthDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reauth-password">{t("password")}</Label>
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reauth-mfa">{t("mfaCode")}</Label>
              <Input
                id="reauth-mfa"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
              />
            </div>
            <Separator />
            <div className="space-y-1">
              <Label htmlFor="confirm-import">{t("commitConfirmationLabel")}</Label>
              <Input
                id="confirm-import"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setReauthOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={reauthBusy || commitMutation.isPending || confirmText !== "IMPORT DATA" || !password}
                onClick={() => commitMutation.mutate()}
              >
                {commitMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                {t("commitAction")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle>{t("importHistory")}</CardTitle>
          <CardDescription>{t("importHistoryDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {historyQuery.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> {tCommon("loading")}
            </div>
          ) : (historyQuery.data?.items ?? []).length === 0 ? (
            <p className="text-muted-foreground py-6 text-sm">{t("noImports")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("targetField")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead>{t("records")}</TableHead>
                    <TableHead>{t("created")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(historyQuery.data?.items ?? []).map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="text-sm">{t(`dataset${job.datasetType.charAt(0).toUpperCase()}${job.datasetType.slice(1)}` as "datasetCustomers")}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Badge variant={job.status === "COMPLETED" ? "default" : job.status === "FAILED" ? "destructive" : "secondary"}>
                            {t.has(`statusLabels.${job.status}`) ? t(`statusLabels.${job.status}` as "statusLabels.READY") : job.status}
                          </Badge>
                          {job.failureCode ? (
                            <p className="text-destructive text-xs">
                              {t.has(`failureLabels.${job.failureCode}`) ? t(`failureLabels.${job.failureCode}` as "failureLabels.IMPORT_EXPIRED") : job.failureCode}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {job.status === "COMPLETED"
                          ? `${job.createdCount ?? 0} / ${job.rowCount ?? 0}`
                          : (job.rowCount ?? "—")}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{new Date(job.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CountBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "bad" | "warn";
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "bad"
        ? "text-destructive"
        : tone === "warn"
          ? "text-amber-700 dark:text-amber-400"
          : "";
  return (
    <div className="rounded-lg border p-3 text-center">
      <p className={`text-xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {label ? <p className="text-muted-foreground mt-1 text-xs">{label}</p> : null}
    </div>
  );
}

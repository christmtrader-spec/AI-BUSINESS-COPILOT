"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, FileDown, Loader2, XCircle } from "lucide-react";

/** Export catalog keys mirrored for the UI (labels via i18n, §191). */
const EXPORT_DATASETS = [
  "business",
  "members",
  "customers",
  "suppliers",
  "products",
  "inventory",
  "sales",
  "expenses",
  "payments",
  "crm_leads",
  "crm_opportunities",
  "crm_activities",
  "crm_tasks",
  "subscription_summary",
  "usage_summary",
] as const;

const SENSITIVITIES: Record<string, "PUBLIC_BUSINESS" | "CONFIDENTIAL"> = {
  business: "PUBLIC_BUSINESS",
  members: "CONFIDENTIAL",
  customers: "CONFIDENTIAL",
  suppliers: "CONFIDENTIAL",
  products: "CONFIDENTIAL",
  inventory: "CONFIDENTIAL",
  sales: "CONFIDENTIAL",
  expenses: "CONFIDENTIAL",
  payments: "CONFIDENTIAL",
  crm_leads: "CONFIDENTIAL",
  crm_opportunities: "CONFIDENTIAL",
  crm_activities: "CONFIDENTIAL",
  crm_tasks: "CONFIDENTIAL",
  subscription_summary: "CONFIDENTIAL",
  usage_summary: "CONFIDENTIAL",
};

/** i18n label key for a dataset (machine key → camelCase message key). */
const DATASET_LABEL_KEYS: Record<string, string> = {
  business: "business",
  members: "members",
  customers: "customers",
  suppliers: "suppliers",
  products: "products",
  inventory: "inventory",
  sales: "sales",
  sale_items: "saleItems",
  expenses: "expenses",
  payments: "payments",
  crm_leads: "crmLeads",
  crm_opportunities: "crmOpportunities",
  crm_activities: "crmActivities",
  crm_tasks: "crmTasks",
  subscription_summary: "subscriptionSummary",
  usage_summary: "usageSummary",
};

function datasetLabelKey(key: string): string {
  return DATASET_LABEL_KEYS[key] ?? key;
}

type ExportJobDTO = {
  id: string;
  status: string;
  format: "JSON" | "CSV";
  datasets: string[];
  recordCount: number | null;
  fileSize: number | null;
  checksum: string | null;
  createdAt: string;
  expiresAt: string | null;
  failureCode: string | null;
  downloadAvailable: boolean;
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("portability");
  const variant =
    status === "COMPLETED"
      ? "default"
      : status === "FAILED"
        ? "destructive"
        : status === "EXPIRED" || status === "CANCELED"
          ? "outline"
          : "secondary";
  const label = t.has(`statusLabels.${status}`) ? t(`statusLabels.${status}` as "statusLabels.COMPLETED") : status;
  return (
    <Badge variant={variant} className="whitespace-nowrap">
      {label}
    </Badge>
  );
}

/** Trigger a browser download of a blob response (no storage of contents). */
async function saveBlobResponse(res: Response, fallbackName: string, t: (key: string) => string) {
  if (!res.ok) throw new Error("download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const dispo = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(dispo);
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  void t;
}

export function ExportPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("portability");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const activeId = useAppStore((s) => s.activeBusinessId);
  const [selected, setSelected] = useState<Set<string>>(new Set(["customers", "suppliers", "products"]));
  const [format, setFormat] = useState<"JSON" | "CSV">("JSON");

  const jobsQuery = useQuery<{ items: ExportJobDTO[]; total: number }>({
    queryKey: ["portability-exports", activeId],
    queryFn: () => api("/api/v1/exports?page=1&pageSize=15"),
    enabled: canManage && !!activeId,
    refetchInterval: (q) =>
      (q.state.data?.items ?? []).some((j) => j.status === "QUEUED" || j.status === "PROCESSING") ? 2500 : false,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const idempotencyKey = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      return api<ExportJobDTO>("/api/v1/exports", {
        method: "POST",
        body: JSON.stringify({ datasets: [...selected], format, idempotencyKey }),
      });
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ["portability-exports"] });
      if (job.status === "COMPLETED") toast.success(t("exportCreatedToast"));
      else if (job.status === "FAILED") toast.error(job.failureCode === "EXPORT_LIMIT_EXCEEDED" ? t("exportLimitToast") : t("exportFailedToast"));
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === "RATE_LIMITED") toast.error(t("exportRateLimitedToast"));
      else if (error instanceof ApiClientError && error.code === "EXPORT_LIMIT_EXCEEDED") toast.error(t("exportLimitToast"));
      else toast.error(t("exportFailedToast"));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api(`/api/v1/exports/${jobId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("canceledToast"));
      queryClient.invalidateQueries({ queryKey: ["portability-exports"] });
    },
    onError: () => toast.error(t("exportFailedToast")),
  });

  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  async function downloadJob(job: ExportJobDTO) {
    setDownloadingId(job.id);
    try {
      const res = await fetch(`/api/v1/exports/${job.id}/download`, {
        credentials: "same-origin",
        headers: activeId ? { "x-business-id": activeId } : undefined,
      });
      const ext = job.format === "CSV" ? "zip" : "json";
      await saveBlobResponse(res, `export-${job.id.slice(-8)}.${ext}`, (k) => t(k as never));
      queryClient.invalidateQueries({ queryKey: ["portability-exports"] });
    } catch {
      toast.error(t("downloadFailed"));
    } finally {
      setDownloadingId(null);
    }
  }

  function toggleDataset(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // NOTE: selecting "sales" also exports its line items — the server
    // applies that implication authoritatively (DATASET_IMPLICATIONS, §46);
    // the UI does not duplicate the bookkeeping.
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{t("roleNote")}</CardContent>
      </Card>
    );
  }

  const items = jobsQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("createExport")}</CardTitle>
          <CardDescription>{t("createExportDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">{t("datasets")}</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {EXPORT_DATASETS.map((key) => (
                <Label
                  key={key}
                  htmlFor={`ds-${key}`}
                  className="hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-3"
                >
                  <Checkbox
                    id={`ds-${key}`}
                    checked={selected.has(key)}
                    onCheckedChange={() => toggleDataset(key)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{t(`datasetsLabels.${datasetLabelKey(key)}` as "datasetsLabels.customers")}</span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {t(`sensitivity.${SENSITIVITIES[key]}` as "sensitivity.CONFIDENTIAL")}
                    </span>
                  </span>
                </Label>
              ))}
            </div>
          </fieldset>

          <Separator />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("format")}</legend>
            <RadioGroup value={format} onValueChange={(v) => setFormat(v as "JSON" | "CSV")} className="grid gap-2 sm:grid-cols-2">
              <Label htmlFor="fmt-json" className="hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                <RadioGroupItem id="fmt-json" value="JSON" className="mt-0.5" />
                <span className="text-sm">{t("formatJson")}</span>
              </Label>
              <Label htmlFor="fmt-csv" className="hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                <RadioGroupItem id="fmt-csv" value="CSV" className="mt-0.5" />
                <span className="text-sm">{t("formatCsv")}</span>
              </Label>
            </RadioGroup>
          </fieldset>

          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">{t("datasetCount", { count: selected.size })}</span>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || selected.size === 0}>
              {createMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("creatingExport")}
                </>
              ) : (
                <>
                  <FileDown className="size-4" aria-hidden="true" />
                  {t("createExportAction")}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("exportHistory")}</CardTitle>
          <CardDescription>{t("exportHistoryDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {jobsQuery.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> {tCommon("loading")}
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground py-6 text-sm">{t("noExports")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("datasetsCol")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead>{t("formatCol")}</TableHead>
                    <TableHead>{t("records")}</TableHead>
                    <TableHead>{t("size")}</TableHead>
                    <TableHead>{t("expires")}</TableHead>
                    <TableHead className="text-end">{tCommon("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="max-w-52">
                        <span className="block truncate text-sm">
                          {job.datasets.map((d) => t(`datasetsLabels.${datasetLabelKey(d)}` as "datasetsLabels.customers")).join(", ")}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <StatusBadge status={job.status} />
                          {job.failureCode ? (
                            <p className="text-destructive text-xs">{t.has(`failureLabels.${job.failureCode}`) ? t(`failureLabels.${job.failureCode}` as "failureLabels.EXPORT_EXPIRED") : job.failureCode}</p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{job.format}</TableCell>
                      <TableCell className="text-sm">{job.recordCount ?? "—"}</TableCell>
                      <TableCell className="text-sm">{formatBytes(job.fileSize)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {job.expiresAt ? new Date(job.expiresAt).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="inline-flex gap-1">
                          {job.downloadAvailable ? (
                            <Button size="sm" variant="outline" onClick={() => downloadJob(job)} disabled={downloadingId === job.id}>
                              {downloadingId === job.id ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                              {t("download")}
                            </Button>
                          ) : null}
                          {job.status === "QUEUED" || job.status === "PROCESSING" ? (
                            <Button size="sm" variant="ghost" onClick={() => cancelMutation.mutate(job.id)}>
                              <XCircle className="size-4" aria-hidden="true" />
                              {t("cancelExport")}
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
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

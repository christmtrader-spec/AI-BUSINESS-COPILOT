"use client";

/**
 * AI cost internal area (§38-§53). Tabs: overview · rates · ledger ·
 * reconciliation · economics · anomalies. INTERNAL ONLY — reachable only
 * through the platform gate (tenants get 403 at the API, §52). Reuses the
 * Prompt-26 services for every number; UNKNOWN cost is always shown as
 * UNKNOWN — never 0 (§47). Guard status is display-only here (§51).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, CheckCircle2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  platformMutations,
  platformQueries,
  type PlatformAiCostRate,
} from "./platform-api";
import {
  EmptyState,
  ListSkeleton,
  PaginationBar,
  ReauthDialog,
  StatusBadge,
  formatDateTime,
  usePlatformErrorText,
} from "./kit";

const PLANS = ["STARTER", "BUSINESS", "PRO"];

export function AiCostView() {
  const t = useTranslations("platform");
  return (
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList className="flex flex-wrap">
        <TabsTrigger value="overview">{t("aiCost.tabs.overview")}</TabsTrigger>
        <TabsTrigger value="rates">{t("aiCost.tabs.rates")}</TabsTrigger>
        <TabsTrigger value="ledger">{t("aiCost.tabs.ledger")}</TabsTrigger>
        <TabsTrigger value="reconciliation">{t("aiCost.tabs.reconciliation")}</TabsTrigger>
        <TabsTrigger value="economics">{t("aiCost.tabs.economics")}</TabsTrigger>
        <TabsTrigger value="anomalies">{t("aiCost.tabs.anomalies")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <AiCostOverviewTab />
      </TabsContent>
      <TabsContent value="rates">
        <AiRatesTab />
      </TabsContent>
      <TabsContent value="ledger">
        <AiLedgerTab />
      </TabsContent>
      <TabsContent value="reconciliation">
        <AiReconciliationTab />
      </TabsContent>
      <TabsContent value="economics">
        <AiEconomicsTab />
      </TabsContent>
      <TabsContent value="anomalies">
        <AiAnomaliesTab />
      </TabsContent>
    </Tabs>
  );
}

/* -------------------------------- overview -------------------------------- */

function AiCostOverviewTab() {
  const t = useTranslations("platform");
  const [windowDays, setWindowDays] = React.useState(30);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "ai-overview", windowDays],
    queryFn: () => platformQueries.aiCostOverview(windowDays),
    refetchOnWindowFocus: false,
  });

  if (isLoading) return <ListSkeleton rows={3} />;
  if (isError || !data) return <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />;
  const h = data.health;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
          <SelectTrigger className="w-40" aria-label={t("aiCost.window")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[7, 30, 90, 365].map((d) => (
              <SelectItem key={d} value={String(d)}>
                {t("aiCost.windowDays", { days: d })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground text-xs font-medium">{t("aiCost.knownRecords")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{h.knownRecords}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground text-xs font-medium">{t("aiCost.unknownRecords")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-semibold tabular-nums">{h.unknownRecords}</p>
            <p className="text-muted-foreground text-xs">{t("aiCost.unknownNote")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground text-xs font-medium">{t("aiCost.costCoverage")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{(h.costCoverageBps / 100).toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground text-xs font-medium">{t("aiCost.guard")}</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={h.guardStatus === "ENABLED" ? "READY" : "DISABLED"} label={h.guardStatus === "ENABLED" ? t("aiCost.guardEnabled") : t("aiCost.guardDisabled")} />
            <p className="text-muted-foreground mt-1 text-xs">{t("aiCost.guardNote")}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("aiCost.byProviderModel")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.breakdown.byProvider.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("overview.noData")}</p>
            ) : (
              <ul className="space-y-2">
                {data.breakdown.byModel.map((r) => (
                  <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-mono text-xs" dir="ltr">
                      {r.key}
                    </span>
                    <span className="text-muted-foreground tabular-nums text-xs" dir="ltr">
                      {r.requests} req · {r.knownRecords} known / {r.unknownRecords} unknown
                      {Object.entries(r.knownCostNanoMinorByCurrency).length > 0
                        ? ` · ${Object.entries(r.knownCostNanoMinorByCurrency)
                            .map(([c, v]) => `${v} ${c}`)
                            .join(", ")}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("aiCost.unknownGroups")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.unknownGroups.groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("overview.noData")}</p>
            ) : (
              <ul className="space-y-1.5">
                {data.unknownGroups.groups.map((g) => (
                  <li key={`${g.provider}-${g.model}-${g.reason}-${g.businessId}`} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs" dir="ltr">
                      {g.reason ?? "—"} · {g.provider}/{g.model}
                    </span>
                    <span className="tabular-nums">{g.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* --------------------------------- rates ---------------------------------- */

function AiRatesTab() {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [deactivateTarget, setDeactivateTarget] = React.useState<PlatformAiCostRate | null>(null);
  const [verifyTarget, setVerifyTarget] = React.useState<PlatformAiCostRate | null>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: "20", includeInactive: "true" });
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "ai-rates", params.toString()],
    queryFn: () => platformQueries.aiRates(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rates = data?.rates ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{t("aiCost.ratesHint")}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          {t("aiCost.createRate")}
        </Button>
      </div>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rates.length === 0 ? (
        <EmptyState label={t("aiCost.noRates")} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("aiCost.providerModel")}</TableHead>
                  <TableHead>{t("aiCost.env")}</TableHead>
                  <TableHead>{t("aiCost.window")}</TableHead>
                  <TableHead>{t("aiCost.verified")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rates.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-mono text-xs" dir="ltr">
                        {r.provider} / {r.model}
                      </div>
                      <div className="text-muted-foreground text-[10px]" dir="ltr">
                        {r.currency} · {r.version}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={r.environment === "PRODUCTION" ? "ACTIVE" : "NOT_CONFIGURED"}
                        label={r.environment}
                      />
                      {!r.active ? (
                        <div className="mt-1">
                          <StatusBadge status="DISABLED" label={t("aiCost.inactive")} />
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-[10px]" dir="ltr">
                      {formatDateTime(r.effectiveFrom)}
                      <br />→ {r.effectiveTo ? formatDateTime(r.effectiveTo) : "∞"}
                    </TableCell>
                    <TableCell>
                      {r.verified ? (
                        <StatusBadge status="KNOWN" label={t("aiCost.verified")} />
                      ) : (
                        <StatusBadge status="UNKNOWN" label={t("aiCost.unverified")} />
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        {!r.verified ? (
                          <Button variant="outline" size="sm" onClick={() => setVerifyTarget(r)}>
                            <CheckCircle2 className="size-3.5" aria-hidden="true" />
                            {t("aiCost.verify")}
                          </Button>
                        ) : null}
                        {r.active ? (
                          <Button variant="outline" size="sm" onClick={() => setDeactivateTarget(r)}>
                            <Ban className="size-3.5" aria-hidden="true" />
                            {t("aiCost.deactivate")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationBar
            page={data?.page.page ?? 1}
            hasNext={data?.page.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

      {createOpen ? (
        <CreateRateDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ["platform", "ai-rates"] })}
        />
      ) : null}
      {deactivateTarget ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setDeactivateTarget(null)}
          titleKey="dialogs.deactivateRateTitle"
          descriptionKey="dialogs.deactivateRateBody"
          values={{ provider: deactivateTarget.provider, model: deactivateTarget.model }}
          submitting={false}
          onSubmit={({ reason, password }) => {
            platformMutations
              .deactivateAiRate(deactivateTarget.id, { reason, password })
              .then(() => {
                toast.success(t("aiCost.deactivateSuccess"));
                void queryClient.invalidateQueries({ queryKey: ["platform", "ai-rates"] });
                setDeactivateTarget(null);
              })
              .catch((e) => toast.error(tError(e)));
          }}
        />
      ) : null}
      {verifyTarget ? (
        <VerifyRateDialog
          target={verifyTarget}
          onClose={() => setVerifyTarget(null)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ["platform", "ai-rates"] })}
        />
      ) : null}
    </div>
  );
}

function CreateRateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("platform");
  const [environment, setEnvironment] = React.useState<"TEST" | "PRODUCTION">("TEST");
  const [provider, setProvider] = React.useState("z-ai");
  const [model, setModel] = React.useState("");
  const [currency, setCurrency] = React.useState("USD");
  const [version, setVersion] = React.useState("");
  const [inputRate, setInputRate] = React.useState("");
  const [outputRate, setOutputRate] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState("");
  const [effectiveTo, setEffectiveTo] = React.useState("");
  const [sourceReference, setSourceReference] = React.useState("");
  const [verifiedBy, setVerifiedBy] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const tError = usePlatformErrorText();

  const ready =
    provider && model && currency.length === 3 && version &&
    /^\d+$/.test(inputRate) && /^\d+$/.test(outputRate) && effectiveFrom &&
    (environment === "TEST" || (sourceReference && verifiedBy));

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("aiCost.createRateTitle")}</DialogTitle>
            <DialogDescription>{t("aiCost.createRateBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-env">{t("aiCost.env")}</Label>
              <Select value={environment} onValueChange={(v) => setEnvironment(v as "TEST" | "PRODUCTION")}>
                <SelectTrigger id="pf-rate-env">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TEST">TEST</SelectItem>
                  <SelectItem value="PRODUCTION">PRODUCTION</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-provider">{t("aiCost.provider")}</Label>
              <Input id="pf-rate-provider" dir="ltr" value={provider} onChange={(e) => setProvider(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-model">{t("aiCost.model")}</Label>
              <Input id="pf-rate-model" dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model-id / DEFAULT" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-currency">{t("aiCost.currency")}</Label>
              <Input id="pf-rate-currency" dir="ltr" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-version">{t("aiCost.version")}</Label>
              <Input id="pf-rate-version" dir="ltr" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2026-09-v1" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-in">{t("aiCost.inputRate")}</Label>
              <Input id="pf-rate-in" dir="ltr" inputMode="numeric" value={inputRate} onChange={(e) => setInputRate(e.target.value.replace(/[^\d]/g, ""))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-out">{t("aiCost.outputRate")}</Label>
              <Input id="pf-rate-out" dir="ltr" inputMode="numeric" value={outputRate} onChange={(e) => setOutputRate(e.target.value.replace(/[^\d]/g, ""))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-from">{t("aiCost.effectiveFrom")}</Label>
              <Input id="pf-rate-from" type="datetime-local" dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-rate-to">{t("aiCost.effectiveTo")}</Label>
              <Input id="pf-rate-to" type="datetime-local" dir="ltr" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </div>
            {environment === "PRODUCTION" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="pf-rate-src">{t("aiCost.sourceReference")}</Label>
                  <Input id="pf-rate-src" dir="ltr" value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pf-rate-by">{t("aiCost.verifiedBy")}</Label>
                  <Input id="pf-rate-by" dir="ltr" value={verifiedBy} onChange={(e) => setVerifiedBy(e.target.value)} />
                </div>
              </>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">{t("aiCost.ratesNanoHint")}</p>
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!ready} onClick={() => setConfirmOpen(true)}>
              {t("subscriptions.continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmOpen ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setConfirmOpen(false)}
          titleKey="dialogs.createRateConfirmTitle"
          descriptionKey="dialogs.createRateConfirmBody"
          values={{ provider, model, environment }}
          submitting={false}
          onSubmit={({ reason, password }) => {
            platformMutations
              .createAiRate({
                provider,
                model,
                currency,
                version,
                inputRateNanoMinorPer1K: inputRate,
                outputRateNanoMinorPer1K: outputRate,
                effectiveFrom: new Date(effectiveFrom).toISOString(),
                effectiveTo: effectiveTo ? new Date(effectiveTo).toISOString() : null,
                environment,
                ...(sourceReference ? { sourceReference } : {}),
                ...(verifiedBy ? { verifiedBy } : {}),
                reason,
                password,
              })
              .then(() => {
                toast.success(t("aiCost.createSuccess"));
                onDone();
                setConfirmOpen(false);
                onClose();
              })
              .catch((e) => toast.error(tError(e)));
          }}
        />
      ) : null}
    </>
  );
}

function VerifyRateDialog({ target, onClose, onDone }: { target: PlatformAiCostRate; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [verifiedBy, setVerifiedBy] = React.useState("");
  const [sourceReference, setSourceReference] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("aiCost.verifyTitle")}</DialogTitle>
            <DialogDescription>{t("aiCost.verifyBody", { provider: target.provider, model: target.model })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pf-verify-by">{t("aiCost.verifiedBy")}</Label>
              <Input id="pf-verify-by" dir="ltr" value={verifiedBy} onChange={(e) => setVerifiedBy(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-verify-src">{t("aiCost.sourceReference")}</Label>
              <Input id="pf-verify-src" dir="ltr" value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} />
            </div>
          </div>
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!verifiedBy.trim() || !sourceReference.trim()} onClick={() => setConfirmOpen(true)}>
              {t("subscriptions.continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmOpen ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setConfirmOpen(false)}
          titleKey="dialogs.verifyRateConfirmTitle"
          descriptionKey="dialogs.verifyRateConfirmBody"
          submitting={false}
          onSubmit={({ reason, password }) => {
            platformMutations
              .verifyAiRate(target.id, { verifiedBy, sourceReference, reason, password })
              .then(() => {
                toast.success(t("aiCost.verifySuccess"));
                onDone();
                setConfirmOpen(false);
                onClose();
              })
              .catch((e) => toast.error(tError(e)));
          }}
        />
      ) : null}
    </>
  );
}

/* --------------------------------- ledger --------------------------------- */

function AiLedgerTab() {
  const t = useTranslations("platform");
  const [costStatus, setCostStatus] = React.useState("");
  const [page, setPage] = React.useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (costStatus) params.set("costStatus", costStatus);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "ai-ledger", params.toString()],
    queryFn: () => platformQueries.aiLedger(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const records = data?.records ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={costStatus || "all"} onValueChange={(v) => { setCostStatus(v === "all" ? "" : v); setPage(1); }}>
          <SelectTrigger className="w-44" aria-label={t("aiCost.costStatusFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            <SelectItem value="KNOWN">{t("aiCost.known")}</SelectItem>
            <SelectItem value="UNKNOWN">{t("aiCost.unknown")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : records.length === 0 ? (
        <EmptyState label={t("aiCost.ledgerEmpty")} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("aiCost.date")}</TableHead>
                  <TableHead>{t("aiCost.providerModel")}</TableHead>
                  <TableHead>{t("aiCost.tokens")}</TableHead>
                  <TableHead>{t("aiCost.cost")}</TableHead>
                  <TableHead>{t("aiCost.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-muted-foreground text-[10px]" dir="ltr">
                      {formatDateTime(r.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      {r.provider}/{r.model}
                      <div className="text-[10px] text-muted-foreground">{r.planCodeAtUsage}</div>
                    </TableCell>
                    <TableCell className="tabular-nums text-xs" dir="ltr">
                      {r.totalTokens ?? "—"}
                      <div className="text-[10px] text-muted-foreground">{r.tokenStatus}</div>
                    </TableCell>
                    <TableCell className="tabular-nums text-xs" dir="ltr">
                      {r.costStatus === "KNOWN" && r.costNanoMinor ? `${r.costNanoMinor} ${r.currency ?? ""}` : "—"}
                    </TableCell>
                    <TableCell>
                      {r.costStatus === "KNOWN" ? (
                        <StatusBadge status="KNOWN" label={t("aiCost.known")} />
                      ) : (
                        <div className="space-y-1">
                          <StatusBadge status="UNKNOWN" label={t("aiCost.unknown")} />
                          <div className="text-muted-foreground font-mono text-[10px]" dir="ltr">
                            {r.unknownReason}
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationBar
            page={data?.page.page ?? 1}
            hasNext={data?.page.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}
    </div>
  );
}

/* ----------------------------- reconciliation ------------------------------ */

function AiReconciliationTab() {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [report, setReport] = React.useState<Awaited<ReturnType<typeof platformQueries.aiReconcile>>["report"] | null>(null);
  const [reason, setReason] = React.useState("");
  const [applyOpen, setApplyOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const dryRun = () => {
    setBusy(true);
    platformQueries
      .aiReconcile({ mode: "dry-run", reason: reason.trim() || "dry-run view" })
      .then((res) => setReport(res.report))
      .catch((e) => toast.error(tError(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("aiCost.reconcileTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">{t("aiCost.reconcileBody")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("aiCost.reconcileReasonPlaceholder")}
              maxLength={300}
            />
            <Button variant="outline" disabled={busy} onClick={dryRun}>
              <Play className="size-3.5" aria-hidden="true" />
              {t("aiCost.dryRun")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {report ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("aiCost.dryRunResult")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label={t("aiCost.candidates")} value={report.candidateRecordCount} />
              <MiniStat label={t("aiCost.eligible")} value={report.eligibleRecords} />
              <MiniStat label={t("aiCost.rateMissing")} value={report.rateMissing} />
              <MiniStat label={t("aiCost.wouldUpdate")} value={report.wouldUpdateCount} />
              <MiniStat label={t("aiCost.tokenIncomplete")} value={report.tokenIncomplete} />
              <MiniStat label={t("aiCost.currencyMismatch")} value={report.currencyMismatch} />
              <MiniStat label={t("aiCost.conflicts")} value={report.conflicts} />
              <MiniStat label={t("aiCost.updated")} value={report.updatedCount} />
            </div>
            <Separator />
            <p className="text-muted-foreground text-xs" dir="ltr">
              {report.boundedWindow.from} → {report.boundedWindow.to}
            </p>
            <Button disabled={report.wouldUpdateCount === 0} onClick={() => setApplyOpen(true)}>
              {t("aiCost.apply")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {applyOpen ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setApplyOpen(false)}
          titleKey="dialogs.reconcileApplyTitle"
          descriptionKey="dialogs.reconcileApplyBody"
          typedConfirmation={{ expected: "RECONCILE" }}
          submitting={busy}
          onSubmit={({ reason: r, password }) => {
            setBusy(true);
            platformMutationsRawReconcile(r, password)
              .then((res) => {
                setReport(res.report);
                toast.success(t("aiCost.applySuccess", { count: res.report.updatedCount }));
                void queryClient.invalidateQueries({ queryKey: ["platform", "ai-ledger"] });
                void queryClient.invalidateQueries({ queryKey: ["platform", "ai-overview"] });
                setApplyOpen(false);
              })
              .catch((e) => toast.error(tError(e)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}

/** Direct call so the apply result refreshes the visible report. */
function platformMutationsRawReconcile(reason: string, password: string) {
  return platformQueries.aiReconcile({ mode: "apply", reason, confirmation: "RECONCILE", password });
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/* -------------------------------- economics -------------------------------- */

function AiEconomicsTab() {
  const t = useTranslations("platform");
  const [planCode, setPlanCode] = React.useState("STARTER");
  const [billingPeriod, setBillingPeriod] = React.useState("MONTHLY");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "ai-economics", planCode, billingPeriod],
    queryFn: () => platformQueries.aiEconomics(planCode, billingPeriod),
    refetchOnWindowFocus: false,
  });

  const e = data?.economics;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("aiCost.economicsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select value={planCode} onValueChange={setPlanCode}>
              <SelectTrigger className="w-40" aria-label={t("subscriptions.filterPlan")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLANS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={billingPeriod} onValueChange={setBillingPeriod}>
              <SelectTrigger className="w-40" aria-label={t("subscriptions.filterStatus")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MONTHLY">MONTHLY</SelectItem>
                <SelectItem value="YEARLY">YEARLY</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {isLoading ? (
            <ListSkeleton rows={2} />
          ) : isError || !e ? (
            <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <StatusBadge
                  status={e.status === "COMPARABLE" ? "COMPARABLE" : e.status}
                  label={t(`aiCost.economicsStatus.${e.status}` as Parameters<typeof t>[0])}
                />
                <span className="text-muted-foreground text-xs">
                  {t("aiCost.contributionLabel")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label={t("aiCost.price")} value={e.priceMinor ?? 0} />
                <MiniStat label={t("aiCost.sampleSize")} value={e.sampleSize} />
                <MiniStat label={t("aiCost.coverage")} value={e.costCoverageBps} />
                <MiniStat label={t("aiCost.marginBps")} value={e.contributionMarginBps ?? 0} />
              </div>
              {Object.keys(e.knownCostNanoMinorByCurrency).length > 0 ? (
                <ul className="space-y-1 text-xs" dir="ltr">
                  {Object.entries(e.knownCostNanoMinorByCurrency).map(([cur, nano]) => (
                    <li key={cur} className="flex justify-between font-mono">
                      <span>{cur}</span>
                      <span>{nano} nm</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-muted-foreground text-xs">{t("aiCost.economicsNote")}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------- anomalies -------------------------------- */

function AiAnomaliesTab() {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "ai-anomalies", params.toString()],
    queryFn: () => platformQueries.aiAnomalies(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows = data?.anomalies ?? [];

  return (
    <div className="space-y-4">
      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("aiCost.anomaliesEmpty")} />
      ) : (
        <>
          <div className="space-y-2">
            {rows.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={a.severity === "CRITICAL" ? "CRITICAL" : a.severity === "WARNING" ? "OPEN" : "INFO"}
                      label={a.severity}
                    />
                    <span className="font-mono text-xs" dir="ltr">
                      {a.type}
                    </span>
                    <StatusBadge status={a.status} label={t(`aiCost.anomalyStatus.${a.status}` as Parameters<typeof t>[0])} />
                  </div>
                  <p className="text-muted-foreground font-mono text-[10px]" dir="ltr">
                    {a.metric}: {a.currentValue ?? "—"} (base {a.baseline ?? "—"})
                  </p>
                  <p className="text-muted-foreground text-[10px]" dir="ltr">
                    {formatDateTime(a.windowStart)} → {formatDateTime(a.windowEnd)}
                  </p>
                </div>
                {a.status === "OPEN" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      platformMutations
                        .acknowledgeAnomaly(a.id, {})
                        .then(() => {
                          toast.success(t("aiCost.ackSuccess"));
                          void queryClient.invalidateQueries({ queryKey: ["platform", "ai-anomalies"] });
                        })
                        .catch((e) => toast.error(tError(e)))
                    }
                  >
                    {t("aiCost.acknowledge")}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          <PaginationBar
            page={data?.page.page ?? 1}
            hasNext={data?.page.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}
    </div>
  );
}

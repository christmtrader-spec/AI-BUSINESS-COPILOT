"use client";

/**
 * Platform Security Center (Prompt 63) — the "ورود و خروج" monitor:
 * authentication / session / account-lifecycle counters plus a filterable,
 * paginated feed of security events. Read-only; every failure surfaces
 * through the safe error mapper (§86/§137) — never raw server text.
 * Mono/technical tokens (event types, reason codes, ip hashes) always
 * render dir="ltr" so EN/FA + RTL behave identically.
 *
 * R64 — failed-login burst surfacing (summary card + anomaly banner +
 * detail dialog over /security/anomalies) and an audited CSV export that
 * mirrors the EXACT on-screen filter set (one shared builder, two consumers).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Ban,
  Download,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  ShieldAlert,
  TriangleAlert,
  UserX,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadCsv, exportStamp } from "@/lib/csv";
import {
  exportSecurityEventsCsv,
  platformQueries,
  type PlatformSecurityEvent,
  type PlatformSecurityAnomalies,
} from "./platform-api";
import {
  EmptyState,
  ListSkeleton,
  PaginationBar,
  StatusBadge,
  formatCount,
  formatDateTime,
  usePlatformErrorText,
} from "./kit";

const PAGE_SIZE = 20;

/** "Show me the failed logins" preset — fixed server event-type vocabulary. */
const FAILED_LOGIN_PRESET = { eventType: "auth.login.failed", result: "FAILED" as const };

/** Mirror of the server's SECURITY_EXPORT_MAX_ROWS — for the honest truncation toast. */
const SECURITY_EXPORT_CAP = 5_000;

const USER_AGENT_CLIP = 40;

export function SecurityView() {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();

  // Selects apply immediately; text/date drafts apply on Enter / Apply.
  const [eventType, setEventType] = React.useState("");
  const [result, setResult] = React.useState("ALL");
  const [userDraft, setUserDraft] = React.useState("");
  const [fromDraft, setFromDraft] = React.useState("");
  const [toDraft, setToDraft] = React.useState("");
  const [applied, setApplied] = React.useState({ user: "", from: "", to: "" });
  const [page, setPage] = React.useState(1);
  const [anomOpen, setAnomOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  const applyDrafts = React.useCallback(() => {
    setApplied({ user: userDraft.trim(), from: fromDraft, to: toDraft });
    setPage(1);
  }, [fromDraft, toDraft, userDraft]);

  const resetFilters = React.useCallback(() => {
    setEventType("");
    setResult("ALL");
    setUserDraft("");
    setFromDraft("");
    setToDraft("");
    setApplied({ user: "", from: "", to: "" });
    setPage(1);
  }, []);

  const applyFailedLoginPreset = React.useCallback(() => {
    setEventType(FAILED_LOGIN_PRESET.eventType);
    setResult(FAILED_LOGIN_PRESET.result);
    setUserDraft("");
    setFromDraft("");
    setToDraft("");
    setApplied({ user: "", from: "", to: "" });
    setPage(1);
  }, []);

  // ONE shared filter builder — the events feed AND the CSV export must
  // always describe the same on-screen filter set (R64: one builder,
  // two consumers, like the server's own §81 parser law).
  const buildFilterParams = React.useCallback(() => {
    const p = new URLSearchParams();
    if (eventType) p.set("eventType", eventType);
    if (result === "SUCCESS") p.set("success", "true");
    if (result === "FAILED") p.set("success", "false");
    if (applied.user) {
      // A value containing "@" is treated as an email; anything else as a user id.
      if (applied.user.includes("@")) p.set("email", applied.user);
      else p.set("userId", applied.user);
    }
    if (applied.from) p.set("createdFrom", applied.from);
    if (applied.to) p.set("createdTo", applied.to);
    return p;
  }, [eventType, result, applied]);

  const eventsParams = React.useMemo(() => {
    const p = buildFilterParams();
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    return p.toString();
  }, [buildFilterParams, page]);

  const summary = useQuery({
    queryKey: ["platform", "security", "summary"],
    queryFn: platformQueries.securitySummary,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  const events = useQuery({
    queryKey: ["platform", "security", "events", eventsParams],
    queryFn: () => platformQueries.securityEvents(eventsParams),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  // R64 — burst detail. Fetched only while the dialog is open (permission is
  // the same platform:security:read; server re-verifies per call).
  const anomalies = useQuery({
    queryKey: ["platform", "security", "anomalies"],
    queryFn: platformQueries.securityAnomalies,
    enabled: anomOpen,
    refetchOnWindowFocus: false,
  });

  const summaryError = summary.isError ? errorText(summary.error) : null;
  const eventsError = events.isError ? errorText(events.error) : null;
  const rows: PlatformSecurityEvent[] = events.data?.events ?? [];

  const handleExportCsv = React.useCallback(async () => {
    setExporting(true);
    try {
      // Export reads the SAME committed filters the list is showing — never
      // the un-applied drafts.
      const filters = buildFilterParams().toString();
      const { csv, truncated, rows: exportedRows } = await exportSecurityEventsCsv(filters);
      downloadCsv(`security-events-${exportStamp()}.csv`, csv);
      if (truncated) {
        toast.warning(t("security.exportTruncated", { rows: exportedRows, cap: SECURITY_EXPORT_CAP }));
      } else {
        toast.success(t("security.exportSuccess", { rows: exportedRows }));
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setExporting(false);
    }
  }, [buildFilterParams, errorText, t]);

  const summaryCards: Array<{
    key: string;
    label: string;
    value: number;
    icon: LucideIcon;
    danger?: boolean;
    onClick?: () => void;
  }> = summary.data
    ? [
        {
          key: "failedLogins",
          label: t("security.failedLogins"),
          value: summary.data.failedLogins24h,
          icon: ShieldAlert,
          danger: summary.data.failedLogins24h > 0,
          onClick: applyFailedLoginPreset,
        },
        {
          key: "failedLoginBursts",
          label: t("security.failedLoginBursts"),
          value: summary.data.failedLoginBursts1h,
          icon: TriangleAlert,
          danger: summary.data.failedLoginBursts1h > 0,
          onClick: () => setAnomOpen(true),
        },
        { key: "logins", label: t("security.logins"), value: summary.data.logins24h, icon: LogIn },
        { key: "rateLimited", label: t("security.rateLimited"), value: summary.data.rateLimitedLogins24h, icon: Ban },
        { key: "mfaFailures", label: t("security.mfaFailures"), value: summary.data.mfaFailures24h, icon: KeyRound },
        { key: "revocations", label: t("security.revocations"), value: summary.data.sessionRevocations7d, icon: LogOut },
        { key: "suspendedUsers", label: t("security.suspendedUsers"), value: summary.data.suspendedUsers, icon: UserX },
        { key: "activeOperators", label: t("security.activeOperators"), value: summary.data.activeOperators, icon: UsersRound },
        { key: "activeSessions", label: t("security.activeSessions"), value: summary.data.activeSessions, icon: Monitor },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("security.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("security.description")}</p>
      </div>

      {summary.isLoading && !summary.data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : summaryError ? (
        <p role="alert" className="text-destructive text-sm">
          {summaryError}
        </p>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t("security.title")}>
          {summaryCards.map((c) => {
            const Icon = c.icon;
            const tone = c.danger ? "border-destructive/40" : "border-border";
            const body = (
              <>
                <div className="flex items-center gap-1.5">
                  <Icon
                    className={`size-3.5 ${c.danger ? "text-destructive" : "text-muted-foreground"}`}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground text-xs font-medium">{c.label}</span>
                </div>
                <p className="text-2xl font-semibold tabular-nums">{formatCount(c.value)}</p>
              </>
            );
            return c.onClick ? (
              <button
                key={c.key}
                type="button"
                onClick={c.onClick}
                aria-label={c.label}
                className={`${tone} hover:bg-accent/40 bg-card rounded-xl border p-4 text-start shadow-sm transition-colors focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]`}
              >
                {body}
              </button>
            ) : (
              <div key={c.key} className={`${tone} bg-card rounded-xl border p-4 shadow-sm`}>
                {body}
              </div>
            );
          })}
        </section>
      )}

      <Card>
        <CardContent className="pt-4">
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              applyDrafts();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="pf-sec-event">{t("security.filterEvent")}</Label>
              <Select
                value={eventType || "ALL"}
                onValueChange={(v) => {
                  setEventType(v === "ALL" ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger id="pf-sec-event" aria-label={t("security.filterEvent")} className="w-full">
                  <SelectValue placeholder={t("security.filterEventAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("security.filterEventAll")}</SelectItem>
                  {(events.data?.facets.eventTypes ?? []).map((et) => (
                    <SelectItem key={et} value={et}>
                      <span className="font-mono" dir="ltr">
                        {et}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pf-sec-result">{t("security.filterResult")}</Label>
              <Select
                value={result}
                onValueChange={(v) => {
                  setResult(v);
                  setPage(1);
                }}
              >
                <SelectTrigger id="pf-sec-result" aria-label={t("security.filterResult")} className="w-full">
                  <SelectValue placeholder={t("security.resultAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("security.resultAll")}</SelectItem>
                  <SelectItem value="SUCCESS">{t("security.resultSuccess")}</SelectItem>
                  <SelectItem value="FAILED">{t("security.resultFailed")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pf-sec-user">{t("security.filterUser")}</Label>
              <Input
                id="pf-sec-user"
                dir="ltr"
                value={userDraft}
                onChange={(e) => setUserDraft(e.target.value)}
                placeholder={t("security.filterUserPlaceholder")}
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pf-sec-from">{t("security.filterFrom")}</Label>
              <Input
                id="pf-sec-from"
                type="date"
                dir="ltr"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pf-sec-to">{t("security.filterTo")}</Label>
              <Input
                id="pf-sec-to"
                type="date"
                dir="ltr"
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
              />
            </div>

            <div className="flex items-end gap-2 lg:col-span-3">
              <Button type="submit" data-testid="pf-sec-apply">
                {t("security.apply")}
              </Button>
              <Button type="button" variant="outline" onClick={resetFilters}>
                {t("security.reset")}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="pf-sec-export"
                disabled={exporting}
                onClick={() => void handleExportCsv()}
              >
                {exporting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                {exporting ? t("security.exportingCsv") : t("security.exportCsv")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* R64 — burst banner: sits ABOVE the events list, only when the
          summary actually counts an active burst. Icon + text carry the
          meaning; amber is the accent, never the sole signal. */}
      {summary.data && summary.data.failedLoginBursts1h > 0 ? (
        <div
          data-testid="pf-sec-anom-banner"
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <TriangleAlert
            className="size-4 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="min-w-48 flex-1 text-sm text-amber-900 dark:text-amber-200">
            {t("security.anomBanner", { total: summary.data.failedLoginBursts1h })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="pf-sec-anom-open"
            onClick={() => setAnomOpen(true)}
          >
            {t("security.anomBannerAction")}
          </Button>
        </div>
      ) : null}

      {events.isLoading && !events.data ? (
        <ListSkeleton />
      ) : eventsError ? (
        <p role="alert" className="text-destructive text-sm">
          {eventsError}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState label={t("security.empty")} />
      ) : (
        <>
          <div className="space-y-2" data-testid="pf-sec-events">
            {rows.map((e) => {
              const ua = e.userAgent ?? "";
              return (
                <div key={e.id} data-testid="pf-sec-row" className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusBadge
                      status={e.success ? "SUCCEEDED" : "FAILED"}
                      label={e.success ? t("security.resultSuccess") : t("security.resultFailed")}
                    />
                    <span className="font-mono text-xs font-semibold" dir="ltr">
                      {e.eventType}
                    </span>
                    <span className="text-muted-foreground text-xs">{formatDateTime(e.createdAt)}</span>
                    {e.email ? (
                      <span className="text-muted-foreground text-xs" dir="ltr">
                        {e.email}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    {e.ipHashPrefix ? (
                      <span className="text-muted-foreground">
                        ip: <span className="font-mono" dir="ltr">{`ip#${e.ipHashPrefix}`}</span>
                      </span>
                    ) : null}
                    {ua ? (
                      <span className="text-muted-foreground max-w-full break-all" dir="ltr" title={ua}>
                        {ua.length > USER_AGENT_CLIP ? `${ua.slice(0, USER_AGENT_CLIP)}…` : ua}
                      </span>
                    ) : null}
                  </div>
                  {e.reasonCode ? (
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">{t("security.reasonLabel")}:</span>
                      <Badge variant="outline" className="font-mono" dir="ltr">
                        {e.reasonCode}
                      </Badge>
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          <PaginationBar
            page={events.data?.page.page ?? 1}
            hasNext={events.data?.page.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

      <AnomaliesDialog open={anomOpen} onOpenChange={setAnomOpen} query={anomalies} />
    </div>
  );
}

/**
 * R64 — failed-login burst detail. Two labeled groups (by email / by IP
 * prefix) over the server-owned window; the server's own threshold/window
 * values render in the caption so the client never restates them from
 * guesses. Empty groups say so honestly.
 */
function AnomaliesDialog({
  open,
  onOpenChange,
  query,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: { data?: PlatformSecurityAnomalies; isLoading: boolean; isError: boolean; error: unknown };
}) {
  const t = useTranslations("platform");
  const errorText = usePlatformErrorText();
  const data = query.data;

  const renderGroup = (title: string, buckets: PlatformSecurityAnomalies["emailBursts"], testid: string, ipMode: boolean) => (
    <div className="space-y-1.5" data-testid={testid}>
      <p className="text-xs font-semibold">{title}</p>
      {buckets.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("security.anomNone")}</p>
      ) : (
        <ul className="space-y-1">
          {buckets.map((b) => (
            <li
              key={b.key}
              data-testid="pf-sec-anom-row"
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border p-2 text-xs"
            >
              <span className="font-mono font-medium" dir="ltr">
                {ipMode ? `ip#${b.key}` : b.key}
              </span>
              <Badge variant="outline" className="tabular-nums">
                {formatCount(b.count)}
              </Badge>
              <span className="text-muted-foreground ms-auto">
                {t("security.anomLastAt")}: {formatDateTime(b.lastAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("security.anomTitle")}</DialogTitle>
          <DialogDescription>{t("security.anomDesc")}</DialogDescription>
        </DialogHeader>
        {query.isLoading && !data ? (
          <ListSkeleton />
        ) : query.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(query.error)}
          </p>
        ) : data ? (
          <div className="space-y-4">
            {renderGroup(t("security.anomByEmail"), data.emailBursts, "pf-sec-anom-email", false)}
            {renderGroup(t("security.anomByIp"), data.ipBursts, "pf-sec-anom-ip", true)}
            <p className="text-muted-foreground text-xs" data-testid="pf-sec-anom-threshold">
              {t("security.anomThreshold", { threshold: data.threshold, window: data.windowMinutes })}
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

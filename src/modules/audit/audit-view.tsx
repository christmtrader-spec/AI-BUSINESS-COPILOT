"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { BookmarkPlus, Download, Filter, Loader2, ScrollText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api-client";
import { asRole, can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import type { AuditEntry, BusinessListItem } from "../shell/types";

function formatAction(action: string): string {
  return action.replace(/[._-]+/g, " ");
}

function initialsOf(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}

/** Prompt 52 §F10 — server facet shape for the filter pickers. */
type AuditFacets = {
  actions: { value: string; count: number }[];
  entityTypes: { value: string; count: number }[];
  actors: { id: string; name: string | null; email: string }[];
};

type AuditPage = { items: AuditEntry[]; facets: AuditFacets };

const NONE = "__none__";

// ---- R61 — saved audit views (one-click filter presets) -------------------
/** One saved filter preset; persisted per business in localStorage. */
type SavedAuditView = {
  id: string;
  name: string;
  action: string;
  entityType: string;
  actorId: string;
  from: string;
  to: string;
};

const SAVED_VIEWS_MAX = 10;
const SAVED_NAME_MAX = 40;

function genSavedViewId(): string {
  // cuid-like opaque id; crypto.randomUUID when available (secure contexts).
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Defensive re-validation of the stored JSON — never trust storage shape. */
function parseSavedViews(raw: unknown): SavedAuditView[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedAuditView[] = [];
  for (const item of raw.slice(0, SAVED_VIEWS_MAX)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const name = s(r.name).trim().slice(0, SAVED_NAME_MAX);
    if (!name) continue;
    out.push({
      id: s(r.id) || genSavedViewId(),
      name,
      action: s(r.action),
      entityType: s(r.entityType),
      actorId: s(r.actorId),
      from: s(r.from),
      to: s(r.to),
    });
  }
  return out;
}

/** Read + validate a business's saved views from localStorage. Safe on the
 *  server (returns []) and against corrupt/unavailable storage (honest []). */
function loadSavedViews(storageKey: string | null): SavedAuditView[] {
  if (!storageKey || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    return parseSavedViews(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Audit log — admin-only, server-filtered activity trail (§F10). */
export function AuditView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("audit");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const billingErrorText = useBillingErrorText();
  const locale = useAppStore((s) => s.locale);
  const activeId = useAppStore((s) => s.activeBusinessId);
  const queryClient = useQueryClient();

  const role: Role = asRole(membership.role);
  const allowed = can(role, "audit:read");

  // ---- §F10 filter state (server-side filtering, debounced-free: the
  // Selects are discrete; the action text applies on submit/Enter) --------
  const [actionInput, setActionInput] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = useMemo(() => {
    const p = new URLSearchParams({ take: "100", facets: "1" });
    if (action) p.set("action", action);
    if (entityType) p.set("entityType", entityType);
    if (actorId) p.set("actorId", actorId);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) p.set("from", from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) p.set("to", to);
    return p.toString();
  }, [action, entityType, actorId, from, to]);

  const hasFilters = Boolean(action || entityType || actorId || from || to);

  // ---- R61 — saved audit views (localStorage, per business) ---------------
  // localStorage is the SINGLE source of truth: the chip list is a memoized
  // projection of the per-business storage key, and save/delete are plain
  // event handlers that write storage then bump `savedVersion` to re-read.
  // No state-mirroring effect (no setState-in-effect), and switching
  // business reloads for free because the storage key changes.
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [nameError, setNameError] = useState(false);
  const [savedVersion, setSavedVersion] = useState(0);
  const storageKey = activeId ? `audit-saved-views:${activeId}` : null;
  const savedViews = useMemo(() => loadSavedViews(storageKey), [storageKey, savedVersion]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<AuditPage>({
    queryKey: ["audit", activeId, params],
    queryFn: () => api(`/api/v1/audit?${params}`),
    enabled: allowed,
  });

  // CSV export — server-generated from the SAME FILTERED audit rows (single
  // source of truth); the client only streams the blob to a file.
  const csvExport = useMutation({
    mutationFn: async () => {
      const csvParams = new URLSearchParams(params);
      csvParams.delete("facets");
      csvParams.set("format", "csv");
      const res = await fetch(`/api/v1/audit?${csvParams.toString()}`, {
        credentials: "same-origin",
        headers: activeId ? { "x-business-id": activeId } : undefined,
      });
      if (!res.ok) {
        let message = t("csvFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          if (body.error?.code === "RATE_LIMITED") message = t("csvRateLimited");
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
      a.download = match?.[1] ?? "audit-export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast({ title: t("csvExportedToast") });
      // The export itself is audited — refresh so the new entry is visible.
      void queryClient.invalidateQueries({ queryKey: ["audit", activeId] });
    },
    onError: (err) =>
      toast({
        title:
          billingErrorText(err) || (err instanceof Error ? err.message : tErrors("generic")),
        variant: "destructive",
      }),
  });

  // §F10 detail drill-down — the before/after payload was previously
  // invisible; a dialog now shows it honestly (read-only JSON).
  const [detail, setDetail] = useState<AuditEntry | null>(null);

  const fmt = new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (!allowed) {
    return (
      <div className="mx-auto max-w-2xl pt-8" data-view="audit">
        <EmptyState icon={ScrollText} title={tErrors("forbidden")} />
      </div>
    );
  }

  const items = data?.items ?? [];
  const facets = data?.facets;

  function clearFilters() {
    setAction("");
    setActionInput("");
    setEntityType("");
    setActorId("");
    setFrom("");
    setTo("");
  }

  // ---- R61 — saved views: apply / save / delete ---------------------------
  /** The chip whose preset EXACTLY equals the current committed filters. */
  const isSavedViewActive = (v: SavedAuditView) =>
    v.action === action && v.entityType === entityType && v.actorId === actorId && v.from === from && v.to === to;

  function applyView(v: SavedAuditView) {
    // Set BOTH the raw input state and the committed state (the action input
    // normally commits on submit) so the server query refetches at once —
    // the exact same end state the manual submit path produces.
    setActionInput(v.action);
    setAction(v.action);
    setEntityType(v.entityType);
    setActorId(v.actorId);
    setFrom(v.from);
    setTo(v.to);
    toast({ title: t("savedApplied"), description: v.name });
  }

  function submitSave() {
    const name = viewName.trim().slice(0, SAVED_NAME_MAX);
    if (!name) {
      setNameError(true);
      return;
    }
    if (!storageKey) return; // never the case behind the business gate
    const current = loadSavedViews(storageKey);
    if (current.length >= SAVED_VIEWS_MAX) {
      toast({ title: t("savedLimit"), variant: "destructive" });
      return;
    }
    const entry: SavedAuditView = { id: genSavedViewId(), name, action, entityType, actorId, from, to };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...current, entry]));
    } catch {
      // Storage refused the write (quota/private mode) — the chip is NOT
      // shown because it is NOT persisted; say so honestly.
      toast({ title: t("savedSaveFailed"), variant: "destructive" });
      return;
    }
    setSavedVersion((v) => v + 1);
    setSaveOpen(false);
    setViewName("");
    setNameError(false);
  }

  function deleteView(id: string) {
    if (!storageKey) return;
    const next = loadSavedViews(storageKey).filter((v) => v.id !== id);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      toast({ title: tErrors("generic"), variant: "destructive" });
      return;
    }
    setSavedVersion((v) => v + 1);
    toast({ title: t("savedDeleted") });
  }

  function openSaveDialog() {
    setViewName("");
    setNameError(false);
    setSaveOpen(true);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-view="audit">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => csvExport.mutate()}
            disabled={csvExport.isPending}
            title={t("exportCsv")}
          >
            {csvExport.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            <span className="hidden sm:inline" aria-hidden="true">
              {csvExport.isPending ? t("exportingCsv") : t("exportCsv")}
            </span>
            <span className="sr-only">{csvExport.isPending ? t("exportingCsv") : t("exportCsv")}</span>
          </Button>
        }
      />

      {/* R61 — saved audit views: one-click filter presets (per business,
          localStorage). Rendered ONLY when there is something to show —
          with no saved views and no filters there is zero extra clutter.
          Names render as plain React text nodes (XSS-safe by construction). */}
      {hasFilters || savedViews.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="audit-saved-views">
          {savedViews.length > 0 ? (
            <span className="text-muted-foreground text-xs font-medium">{t("savedViews")}</span>
          ) : null}
          {savedViews.map((v) => {
            const active = isSavedViewActive(v);
            return (
              <span
                key={v.id}
                className={cn(
                  "inline-flex items-center overflow-hidden rounded-full border text-xs",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "bg-secondary/60 text-secondary-foreground",
                )}
              >
                <button
                  type="button"
                  onClick={() => applyView(v)}
                  title={v.name}
                  className="max-w-44 truncate px-2.5 py-1"
                >
                  {v.name}
                </button>
                <button
                  type="button"
                  onClick={() => deleteView(v.id)}
                  aria-label={`${tCommon("delete")}: ${v.name}`}
                  className="hover:bg-destructive/10 hover:text-destructive flex items-center px-1.5 py-1"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            );
          })}
          {hasFilters ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-full text-xs"
              onClick={openSaveDialog}
              data-testid="audit-save-view"
            >
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {t("savedSave")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* §F10 — advanced filters: user, action, entity type, date range.
          Everything is applied SERVER-SIDE (the CSV export honors it too). */}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">{t("filterAction")}</Label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setAction(actionInput.trim());
              }}
            >
              <Input
                id="audit-action"
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                placeholder={t("filterActionHint")}
                maxLength={120}
                dir="ltr"
                className="h-9"
              />
            </form>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-entity">{t("filterEntityType")}</Label>
            <Select
              value={entityType || NONE}
              onValueChange={(v) => setEntityType(v === NONE ? "" : v)}
            >
              <SelectTrigger id="audit-entity" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value={NONE}>{t("filterAll")}</SelectItem>
                {(facets?.entityTypes ?? []).map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    <span dir="ltr">{x.value}</span>
                    <span className="text-muted-foreground ms-2 text-xs tabular-nums">
                      {x.count}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-actor">{t("filterActor")}</Label>
            <Select value={actorId || NONE} onValueChange={(v) => setActorId(v === NONE ? "" : v)}>
              <SelectTrigger id="audit-actor" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value={NONE}>{t("filterAll")}</SelectItem>
                {(facets?.actors ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name ?? a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-from">{t("filterFrom")}</Label>
            <Input
              id="audit-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9"
              dir="ltr"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-to">{t("filterTo")}</Label>
            <Input
              id="audit-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="h-9"
              dir="ltr"
            />
          </div>
          <div className="flex items-end gap-2">
            {hasFilters ? (
              <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
                <X className="size-4" aria-hidden="true" />
                {t("filterClear")}
              </Button>
            ) : null}
            <span className="text-muted-foreground ms-auto flex items-center gap-1.5 pb-1 text-xs">
              <Filter className="size-3.5" aria-hidden="true" />
              {t("filterServerSide")}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {error instanceof ApiClientError && error.status === 403
                ? tErrors("forbidden")
                : tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <DataTable<AuditEntry>
              ariaLabel={t("title")}
              sortLocale={locale}
              maxHeightClass="max-h-[34rem]"
              stickyHeader
              refreshing={isFetching && !isLoading}
              onRowClick={(l) => setDetail(l)}
              columns={[
                {
                  id: "time",
                  header: t("time"),
                  className: "w-44",
                  sortValue: (l) => l.createdAt,
                  defaultSortDir: "desc",
                  cell: (l) => (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {fmt.format(new Date(l.createdAt))}
                    </span>
                  ),
                },
                {
                  id: "actor",
                  header: t("actor"),
                  cell: (l) => {
                    const name = l.actor?.name ?? l.actor?.email ?? t("system");
                    return (
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-7 ring-1 ring-border">
                          <AvatarFallback className="bg-teal-500/10 text-[10px] font-semibold text-teal-700 dark:text-teal-300">
                            {l.actor?.name || l.actor?.email
                              ? initialsOf(l.actor?.name ?? l.actor?.email ?? "")
                              : "AI"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="max-w-40 truncate text-sm font-medium">{name}</span>
                      </div>
                    );
                  },
                },
                {
                  id: "action",
                  header: t("action"),
                  cell: (l) => (
                    <Badge variant="secondary" className="font-normal" dir="ltr">
                      {formatAction(l.action)}
                    </Badge>
                  ),
                },
                {
                  id: "entity",
                  header: t("entity"),
                  hideBelow: "sm",
                  cell: (l) => (
                    <span className="text-muted-foreground text-sm">
                      <Ltr>
                        {l.entityType}
                        {l.entityId ? ` · ${l.entityId.slice(-6)}` : ""}
                      </Ltr>
                    </span>
                  ),
                },
              ]}
              rows={items}
              getRowId={(l) => l.id}
              loading={isLoading}
              skeletonRows={6}
              empty={
                <EmptyState
                  icon={ScrollText}
                  title={hasFilters ? t("emptyFiltered") : t("empty")}
                  description={hasFilters ? t("emptyFilteredDesc") : t("emptyDesc")}
                />
              }
            />
          )}
        </CardContent>
      </Card>

      <div className="text-muted-foreground flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {tCommon("retry")}
        </Button>
      </div>

      {/* §F10 — entry detail: full before/after payloads, read-only. */}
      <Dialog open={detail !== null} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2" dir="auto">
                  <Badge variant="secondary" className="font-normal" dir="ltr">
                    {formatAction(detail.action)}
                  </Badge>
                </DialogTitle>
                <DialogDescription dir="auto">
                  {fmt.format(new Date(detail.createdAt))}
                  {" · "}
                  <Ltr>{detail.entityType}</Ltr>
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2.5">
                  <Avatar className="size-8 ring-1 ring-border">
                    <AvatarFallback className="bg-teal-500/10 text-[10px] font-semibold text-teal-700 dark:text-teal-300">
                      {detail.actor?.name || detail.actor?.email
                        ? initialsOf(detail.actor?.name ?? detail.actor?.email ?? "")
                        : "AI"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {detail.actor?.name ?? detail.actor?.email ?? t("system")}
                    </p>
                    {detail.actor?.email ? (
                      <p className="text-muted-foreground truncate text-xs" dir="ltr">
                        {detail.actor.email}
                      </p>
                    ) : null}
                  </div>
                </div>
                {detail.entityId ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <span className="text-muted-foreground text-xs">{t("entity")}</span>
                    <Ltr className="font-mono text-xs">{detail.entityId}</Ltr>
                  </div>
                ) : null}
                {(["before", "after"] as const).map((side) => {
                  const payload = detail[side];
                  if (payload == null || (typeof payload === "object" && Object.keys(payload).length === 0)) {
                    return null;
                  }
                  return (
                    <div key={side} className="space-y-1">
                      <p className="text-muted-foreground text-xs font-semibold uppercase">{side}</p>
                      <pre
                        className="bg-muted/50 max-h-56 overflow-auto rounded-md border p-3 text-xs leading-relaxed"
                        dir="ltr"
                      >
                        {JSON.stringify(payload, null, 2)}
                      </pre>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* R61 — name-and-save dialog for the current filter combination. */}
      <Dialog
        open={saveOpen}
        onOpenChange={(v) => {
          setSaveOpen(v);
          if (!v) setNameError(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle dir="auto">{t("savedTitle")}</DialogTitle>
            <DialogDescription dir="auto">{t("savedDialogDesc")}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submitSave();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="audit-saved-name">{t("savedName")}</Label>
              <Input
                id="audit-saved-name"
                value={viewName}
                maxLength={SAVED_NAME_MAX}
                dir="auto"
                placeholder={t("savedNamePlaceholder")}
                autoFocus
                onChange={(e) => {
                  setViewName(e.target.value);
                  setNameError(false);
                }}
                aria-invalid={nameError || undefined}
              />
              {nameError ? <p className="text-destructive text-xs">{t("savedEmpty")}</p> : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setSaveOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" size="sm">
                {tCommon("save")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

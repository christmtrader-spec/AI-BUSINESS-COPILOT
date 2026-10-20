"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Activity,
  Copy,
  Loader2,
  Plus,
  Send,
  Trash2,
  Webhook as WebhookIcon,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { EmptyState } from "@/components/shared/primitives";

/**
 * Prompt 53 §W — outbound webhook endpoints management card (settings).
 * The signing secret is shown EXACTLY ONCE after creation (the DB stores
 * only its secret-box envelope). Deliveries are fire-and-forget: this card
 * manages endpoints, probes them with an honest test delivery, and shows
 * the recent delivery ledger — it can never replay or fake deliveries.
 */

type EndpointRow = {
  id: string;
  url: string;
  prefix: string;
  events: string;
  active: boolean;
  failureCount: number;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  createdBy: { name: string | null; email: string } | null;
};

type DeliveryRow = {
  id: string;
  event: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
};

export function WebhooksCard({ activeId, editable }: { activeId: string; editable: boolean }) {
  const t = useTranslations("webhooks");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();

  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["sale.created"]);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EndpointRow | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<EndpointRow | null>(null);

  const { data, isLoading } = useQuery<{ items: EndpointRow[]; allowedEvents: string[] }>({
    queryKey: ["webhooks", activeId],
    queryFn: () => api("/api/v1/webhooks"),
    enabled: Boolean(activeId),
  });

  const deliveriesQuery = useQuery<{ items: DeliveryRow[] }>({
    queryKey: ["webhook-deliveries", deliveriesFor?.id],
    queryFn: () => api(`/api/v1/webhooks/${deliveriesFor?.id}/deliveries`),
    enabled: Boolean(deliveriesFor),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      return api<EndpointRow & { secret: string }>("/api/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), events: selectedEvents }),
      });
    },
    onSuccess: (endpoint) => {
      setCreated({ id: endpoint.id, secret: endpoint.secret });
      setUrl("");
      setSelectedEvents(["sale.created"]);
      void queryClient.invalidateQueries({ queryKey: ["webhooks", activeId] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("createFailed"),
        variant: "destructive",
      });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      api(`/api/v1/webhooks/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhooks", activeId] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("updateFailed"),
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (id: string) =>
      api<{ ok: boolean; status: number | null; error: string | null }>(
        `/api/v1/webhooks/${id}/test`,
        { method: "POST" },
      ),
    onSuccess: (outcome) => {
      toast({
        title: outcome.ok
          ? t("testOk", { status: outcome.status ?? 0 })
          : t("testFailed", { status: outcome.status ?? 0 }),
        description: outcome.error ?? undefined,
        variant: outcome.ok ? "default" : "destructive",
      });
      void queryClient.invalidateQueries({ queryKey: ["webhooks", activeId] });
      if (deliveriesFor) {
        void queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", deliveriesFor.id] });
      }
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("testFailedGeneric"),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/webhooks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["webhooks", activeId] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("deleteFailed"),
        variant: "destructive",
      });
    },
  });

  const endpoints = data?.items ?? [];
  const allowedEvents = data?.allowedEvents ?? ["sale.created"];
  const activeCount = endpoints.filter((e) => e.active).length;

  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      toast({ title: tCommon("copied") });
    } catch {
      // Clipboard can be denied — the secret stays visible in the dialog.
    }
  }

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  function statusBadge(row: EndpointRow) {
    if (!row.active) {
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {t("statusPaused")}
        </Badge>
      );
    }
    if (row.lastStatus === null) return null;
    return row.lastStatus >= 200 && row.lastStatus < 300 ? (
      <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800">
        {row.lastStatus}
      </Badge>
    ) : (
      <Badge variant="outline" className="text-destructive border-destructive/40">
        {row.lastStatus}
      </Badge>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <WebhookIcon className="text-primary size-4" aria-hidden="true" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {editable ? (
          <form
            className="space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim() && selectedEvents.length > 0 && !createMutation.isPending) {
                createMutation.mutate();
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="webhook-url">{t("urlLabel")}</Label>
              <Input
                id="webhook-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/abc"
                type="url"
                inputMode="url"
                dir="ltr"
                maxLength={500}
              />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">{t("eventsLabel")}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {allowedEvents.map((event) => (
                  <label
                    key={event}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={selectedEvents.includes(event)}
                      onCheckedChange={() => toggleEvent(event)}
                      aria-label={event}
                    />
                    <span className="font-mono text-xs" dir="ltr">
                      {event}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Button
              type="submit"
              size="sm"
              disabled={!url.trim() || selectedEvents.length === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              {t("create")}
            </Button>
          </form>
        ) : null}

        {isLoading ? (
          <div className="bg-muted/50 space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-md" />
            ))}
          </div>
        ) : endpoints.length === 0 ? (
          <EmptyState icon={WebhookIcon} title={t("none")} description={t("noneDesc")} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {endpoints.map((ep) => (
              <li key={ep.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    dir="ltr"
                    title={ep.url}
                  >
                    {ep.url}
                  </span>
                  {statusBadge(ep)}
                  {editable ? (
                    <Switch
                      checked={ep.active}
                      onCheckedChange={(v) =>
                        toggleMutation.mutate({ id: ep.id, active: v })
                      }
                      disabled={toggleMutation.isPending}
                      aria-label={`${t("statusPaused")} — ${ep.url}`}
                    />
                  ) : null}
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-mono" dir="ltr">
                    {ep.prefix}…
                  </span>
                  <span dir="ltr" className="font-mono">
                    {ep.events.split(",").join(" · ")}
                  </span>
                  {ep.failureCount > 0 ? (
                    <span className="text-destructive">
                      {t("failures", { count: ep.failureCount })}
                    </span>
                  ) : null}
                </div>
                {editable ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7"
                      disabled={testMutation.isPending}
                      onClick={() => testMutation.mutate(ep.id)}
                    >
                      {testMutation.isPending && testMutation.variables === ep.id ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Send className="size-3.5" aria-hidden="true" />
                      )}
                      {t("sendTest")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7"
                      onClick={() => setDeliveriesFor(ep)}
                    >
                      <Activity className="size-3.5" aria-hidden="true" />
                      {t("deliveries")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 h-7"
                      onClick={() => setDeleteTarget(ep)}
                      aria-label={t("delete")}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      {t("delete")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {activeCount > 0 ? (
          <p className="text-muted-foreground text-xs" dir="auto">
            {t("usageHint")}
          </p>
        ) : null}
      </CardContent>

      {/* One-time signing secret display */}
      <Dialog open={created !== null} onOpenChange={(v) => !v && setCreated(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("secretTitle")}</DialogTitle>
            <DialogDescription>{t("secretOnce")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-muted/50 flex items-center gap-2 rounded-md border p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs" dir="ltr">
                {created?.secret}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copySecret()}>
                <Copy className="size-3.5" aria-hidden="true" />
                {tCommon("copy")}
              </Button>
            </div>
            <p className="text-muted-foreground font-mono text-xs" dir="ltr">
              x-abc-signature: t=&lt;unix&gt;,v1=HMAC_SHA256(secret, &quot;t.body&quot;)
            </p>
            <Button className="w-full" onClick={() => setCreated(null)}>
              {tCommon("done")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Recent deliveries ledger */}
      <Dialog open={deliveriesFor !== null} onOpenChange={(v) => !v && setDeliveriesFor(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("deliveriesTitle")}</DialogTitle>
            <DialogDescription className="truncate font-mono" dir="ltr">
              {deliveriesFor?.url}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto" dir="ltr">
            {deliveriesQuery.isLoading ? (
              <div className="bg-muted/50 h-16 animate-pulse rounded-md" />
            ) : (deliveriesQuery.data?.items ?? []).length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">{t("noDeliveries")}</p>
            ) : (
              (deliveriesQuery.data?.items ?? []).map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
                >
                  <span className="font-mono">{d.event}</span>
                  <span
                    className={
                      d.ok
                        ? "font-mono text-emerald-700 dark:text-emerald-400"
                        : "text-destructive font-mono"
                    }
                  >
                    {d.status ?? "ERR"}
                    {d.durationMs !== null ? ` · ${d.durationMs}ms` : ""}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
          <p className="text-muted-foreground text-xs" dir="auto">{tSettings("deliveriesLedgerNote")}</p>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription dir="ltr" className="font-mono">
              {deleteTarget?.url}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                t("delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

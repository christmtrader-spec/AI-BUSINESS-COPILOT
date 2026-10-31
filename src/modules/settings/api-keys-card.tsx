"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { API_KEY_SCOPES } from "@/lib/api-key-scopes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
 * Prompt 52 §F8 — API keys management card (settings).
 * The plaintext key is shown EXACTLY ONCE after creation; the server stores
 * only a SHA-256 hash. Revocation is immediate.
 */

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  lastUsedAt: string | null;
  requestCount: number;
  periodCount?: number;
  revokedAt: string | null;
  createdAt: string;
  createdBy: { name: string | null; email: string } | null;
};

/** "read,read:products" → readable tokens for badges (closed set only). */
function scopeTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => (API_KEY_SCOPES as readonly string[]).includes(s));
}

export function ApiKeysCard({ activeId, editable }: { activeId: string; editable: boolean }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const { data, isLoading } = useQuery<{ items: ApiKeyRow[]; quotaMonthly?: number }>({
    queryKey: ["api-keys", activeId],
    queryFn: () => api("/api/v1/api-keys"),
    enabled: Boolean(activeId),
  });
  const quotaMonthly = data?.quotaMonthly ?? null;

  function toggleScope(scope: string) {
    setScopes((prev) => {
      if (prev.includes(scope)) {
        // never allow an empty selection — keep at least one scope
        return prev.length > 1 ? prev.filter((s) => s !== scope) : prev;
      }
      const next = scope === "read" ? ["read"] : [...prev.filter((s) => s !== "read"), scope];
      return next;
    });
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await api<ApiKeyRow & { key: string }>("/api/v1/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), scopes }),
      });
      return res;
    },
    onSuccess: (key) => {
      setCreated({ id: key.id, key: key.key });
      setName("");
      setScopes(["read"]);
      void queryClient.invalidateQueries({ queryKey: ["api-keys", activeId] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("apiKeyCreateFailed"),
        variant: "destructive",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("apiKeyRevokedToast") });
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["api-keys", activeId] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("apiKeyRevokeFailed"),
        variant: "destructive",
      });
    },
  });

  const keys = data?.items ?? [];
  const activeKeys = keys.filter((k) => k.revokedAt === null);

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      toast({ title: tCommon("copied") });
    } catch {
      // Clipboard can be denied — the raw key stays visible in the dialog.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="text-primary size-4" aria-hidden="true" />
          {t("apiKeysTitle")}
        </CardTitle>
        <CardDescription>{t("apiKeysDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {editable ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && !createMutation.isPending) createMutation.mutate();
            }}
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="apikey-name" className="sr-only">
                {t("apiKeyNameLabel")}
              </Label>
              <Input
                id="apikey-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeyNamePlaceholder")}
                maxLength={80}
              />
              {/* R61-3 scope picker — closed set; "read" is exclusive-full. */}
              <div
                className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1"
                role="group"
                aria-label={t("apiKeyScopesLabel")}
              >
                {(API_KEY_SCOPES as readonly string[]).map((scope) => (
                  <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      className="accent-primary size-3.5"
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    <code className="text-[11px]" dir="ltr">
                      {scope}
                    </code>
                  </label>
                ))}
              </div>
              <p className="text-muted-foreground text-[11px]" dir="auto">
                {t("apiKeyScopesHint")}
              </p>
            </div>
            <Button type="submit" size="sm" disabled={!name.trim() || createMutation.isPending}>
              {createMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              {t("apiKeyCreate")}
            </Button>
          </form>
        ) : null}

        {isLoading ? (
          <div className="bg-muted/50 space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <EmptyState icon={KeyRound} title={t("apiKeyNone")} description={t("apiKeyNoneDesc")} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate" dir="auto">
                      {k.name}
                    </span>
                    {k.revokedAt ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        {t("apiKeyRevoked")}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-xs">
                    <span className="tabular-nums" dir="ltr">
                      {k.prefix}…
                    </span>
                    {scopeTokens(k.scopes).map((s) => (
                      <Badge key={s} variant="secondary" className="font-mono text-[10px]" dir="ltr">
                        {s}
                      </Badge>
                    ))}
                    <span className="tabular-nums" dir="ltr">
                      · {t("apiKeyRequests", { count: k.requestCount })}
                    </span>
                    {typeof k.periodCount === "number" && quotaMonthly != null ? (
                      <span className="tabular-nums" dir="ltr">
                        · {t("apiKeyMonthlyUsage", { used: k.periodCount, quota: quotaMonthly })}
                      </span>
                    ) : null}
                    {k.lastUsedAt ? <span>· {t("apiKeyLastUsed")}</span> : ""}
                  </p>
                </div>
                {k.revokedAt === null && editable ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 size-8"
                    onClick={() => setRevokeTarget(k)}
                    aria-label={t("apiKeyRevoke")}
                    title={t("apiKeyRevoke")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {activeKeys.length > 0 ? (
          <p className="text-muted-foreground text-xs" dir="auto">
            {t("apiKeysUsageHint")}
          </p>
        ) : null}
      </CardContent>

      {/* One-time plaintext display */}
      <Dialog open={created !== null} onOpenChange={(v) => !v && setCreated(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("apiKeyCreatedTitle")}</DialogTitle>
            <DialogDescription>{t("apiKeyCreatedOnce")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-muted/50 flex items-center gap-2 rounded-md border p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-xs" dir="ltr">
                {created?.key}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyKey()}>
                <Copy className="size-3.5" aria-hidden="true" />
                {tCommon("copy")}
              </Button>
            </div>
            <Button className="w-full" onClick={() => setCreated(null)}>
              {tCommon("done")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <AlertDialog open={revokeTarget !== null} onOpenChange={(v) => !v && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apiKeyRevokeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription dir="auto">
              {t("apiKeyRevokeConfirmDesc", {
                name: revokeTarget?.name ?? "",
                prefix: revokeTarget?.prefix ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (revokeTarget) revokeMutation.mutate(revokeTarget.id);
              }}
            >
              {revokeMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                t("apiKeyRevoke")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

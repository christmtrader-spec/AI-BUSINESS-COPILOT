"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  Building2,
  Check,
  Clock,
  Handshake,
  Loader2,
  ShieldX,
  TimerOff,
  UserCheck,
  XCircle,
} from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { asRole } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Splash } from "@/components/shared/primitives";

/**
 * Join-by-invite view (#/join/<token>).
 *
 * Rendered OUTSIDE the normal membership-gated shell (an invitee may have
 * zero businesses yet). Preview → accept → land on the dashboard of the
 * joined business. Everything the user sees comes from the server's
 * preview endpoint — the link itself carries no authority beyond the
 * described one-time membership.
 */
export function JoinInviteView({ token }: { token: string }) {
  const t = useTranslations("join");
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");
  const uiLocale = useLocale();
  const queryClient = useQueryClient();
  const navigate = useAppStore((s) => s.navigate);
  const [accepted, setAccepted] = useState(false);

  const { data: preview, isLoading, error, refetch } = useQuery<{
    businessName: string;
    role: string;
    inviter: { name: string | null; email: string } | null;
    expiresAt: string;
    status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
    callerIsMember: boolean;
  }>({
    queryKey: ["invitePreview", token],
    queryFn: () => api(`/api/v1/invites/${encodeURIComponent(token)}`),
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: async () =>
      api<{ business: { id: string; name: string }; role: string }>(
        `/api/v1/invites/${encodeURIComponent(token)}`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      setAccepted(true);
      toast({ title: t("joinAcceptedToast", { business: data.business.name }) });
      void queryClient.invalidateQueries();
      useAppStore.getState().setActiveBusiness(data.business.id);
      navigate({ kind: "dashboard" }, { replace: true });
    },
    onError: (err) => {
      toast({
        title:
          err instanceof ApiClientError && err.code === "ALREADY_MEMBER"
            ? t("joinAlreadyMember")
            : err instanceof ApiClientError
              ? err.message
              : tErrors("generic"),
        variant: "destructive",
      });
      void refetch();
    },
  });

  if (isLoading) {
    return <Splash label={t("joinLoading")} />;
  }

  if (error || !preview) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="bg-destructive/10 mx-auto flex size-12 items-center justify-center rounded-full">
              <XCircle className="text-destructive size-6" aria-hidden="true" />
            </div>
            <CardTitle className="text-base">{t("joinNotFoundTitle")}</CardTitle>
            <CardDescription>{t("joinNotFoundDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => navigate({ kind: "dashboard" }, { replace: true })}>
              {t("joinGoHome")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = preview.status;
  const effectiveStatus = accepted ? "ACCEPTED" : status;
  const canAccept =
    (effectiveStatus === "PENDING" || effectiveStatus === "ACCEPTED") && !acceptMutation.isPending;

  const statusMeta: Record<
    typeof effectiveStatus,
    { icon: typeof Check; tone: string; label: string }
  > = {
    PENDING: {
      icon: Clock,
      tone: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
      label: t("joinStatusPending"),
    },
    ACCEPTED: {
      icon: Check,
      tone: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
      label: t("joinStatusAccepted"),
    },
    REVOKED: {
      icon: ShieldX,
      tone: "border-destructive/30 bg-destructive/5 text-destructive",
      label: t("joinStatusRevoked"),
    },
    EXPIRED: {
      icon: TimerOff,
      tone: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
      label: t("joinStatusExpired"),
    },
  };
  const StatusIcon = statusMeta[effectiveStatus].icon;

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="border-emerald-500/20 from-emerald-500/15 to-teal-500/10 mx-auto flex size-14 items-center justify-center rounded-2xl border bg-gradient-to-br">
            <Handshake className="text-emerald-700 size-7 dark:text-emerald-400" aria-hidden="true" />
          </div>
          <CardTitle className="text-lg">{t("joinTitle")}</CardTitle>
          <CardDescription>{t("joinSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Business + role summary — all from the server preview. */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
                <Building2 className="text-muted-foreground size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{preview.businessName}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {preview.inviter
                    ? t("joinInvitedBy", {
                        name: preview.inviter.name ?? preview.inviter.email,
                      })
                    : t("joinInviterUnknown")}
                </p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <UserCheck className="size-3.5" aria-hidden="true" />
                {t("joinRoleLabel")}
              </span>
              <Badge variant="secondary">{tSettings(`roles.${asRole(preview.role)}` as "OWNER")}</Badge>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">{t("joinExpiresLabel")}</span>
              <span className="text-xs tabular-nums" dir="ltr">
                {formatDate(preview.expiresAt, uiLocale)}
              </span>
            </div>
          </div>

          {/* Status banner */}
          <div
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium ${statusMeta[effectiveStatus].tone}`}
          >
            <StatusIcon className="size-4 shrink-0" aria-hidden="true" />
            {statusMeta[effectiveStatus].label}
            {effectiveStatus === "EXPIRED" || effectiveStatus === "REVOKED"
              ? ` — ${t("joinStatusRevokedHint")}`
              : ""}
          </div>

          {/* Actions */}
          {effectiveStatus === "PENDING" ? (
            <Button
              className="w-full gap-2"
              size="lg"
              onClick={() => acceptMutation.mutate()}
              disabled={!canAccept}
            >
              {acceptMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
              {acceptMutation.isPending ? t("joinAccepting") : t("joinAccept")}
            </Button>
          ) : null}
          {effectiveStatus === "ACCEPTED" ? (
            <Button
              className="w-full gap-2"
              size="lg"
              onClick={() => navigate({ kind: "dashboard" }, { replace: true })}
            >
              <Building2 className="size-4" aria-hidden="true" />
              {t("joinGoDashboard")}
            </Button>
          ) : null}
          {preview.callerIsMember && effectiveStatus === "PENDING" ? (
            <p className="text-muted-foreground text-center text-[11px]">
              {t("joinAlreadyMemberHint")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function formatDate(iso: string, uiLocale: string): string {
  try {
    return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

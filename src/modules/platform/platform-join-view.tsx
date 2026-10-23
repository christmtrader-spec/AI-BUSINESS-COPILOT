"use client";

/**
 * R67 — platform operator invite redemption (#/platform-join/<token>).
 *
 * Rendered OUTSIDE the auth gate (app-root.tsx): the opaque token IS the
 * authorization (§161 pattern). Preview → redeem → land on the admin
 * sign-in (the fresh operator then hits the per-request MFA enforcement
 * gate — exactly correct for the zero-trust policy §6.2).
 *
 * Honest-UI laws honored:
 *  - Unavailable states (ACCEPTED/REVOKED/EXPIRED/invalid token) each get
 *    distinct copy — never a generic shrug, never a fake form.
 *  - An EXISTING account proves control with its CURRENT password; the
 *    password is NEVER changed by redemption (server refuses a mismatch
 *    with PLATFORM_INVITE_PASSWORD_MISMATCH — surfaced verbatim).
 *  - A NEW account sets its initial password (policy: min 8, letter+number
 *    — the same server policy the signup form describes).
 *  - Brand paint: the R67 purple gradient (#C165DD → #5C27FE) for the
 *    badge/CTA; semantic colors stay semantic (the success check is purple
 *    BRAND, not emerald status — this page has no status-badge semantics).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  ShieldX,
  TimerOff,
} from "lucide-react";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PLATFORM_GRADIENT_CTA, formatDateTime } from "./kit";
import { platformJoinService } from "./platform-api";

/** Glass surface matching the auth card family (auth-view glassCardClass). */
const glassCardClass =
  "relative w-full overflow-hidden border-border/60 bg-background/75 shadow-xl shadow-black/5 backdrop-blur-xl dark:bg-card/60 dark:shadow-black/30";

type Preview = Awaited<ReturnType<typeof platformJoinService.preview>>["invite"];
type RedeemResult = { role: string; accountCreated: boolean };

/** Non-PENDING preview statuses with dedicated copy; anything else degrades
 * to the generic invalid-token copy (never a missing-message crash). */
const UNAVAILABLE_STATUSES = ["ACCEPTED", "REVOKED", "EXPIRED"];

export function PlatformJoinView({ token }: { token: string }) {
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);

  const { data, isLoading, error } = useQuery({
    queryKey: ["platform", "join", token],
    queryFn: () => platformJoinService.preview(token),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const goAdminSignIn = () => navigate({ kind: "platform", section: "overview" });

  return (
    <main
      className="bg-gradient-to-b from-[#C165DD]/10 via-background to-[#5C27FE]/10 flex min-h-svh items-center justify-center px-4 py-8"
      data-testid="pf-join-page"
    >
      <div className="w-full max-w-md">
        {isLoading ? <JoinSkeleton /> : null}

        {!isLoading && error ? (
          <UnavailableCard
            icon={ShieldX}
            title={t("join.unavailable.invalidTitle")}
            body={t("join.unavailable.invalidBody")}
            ctaLabel={t("join.goAdminSignIn")}
            onCta={goAdminSignIn}
          />
        ) : null}

        {!isLoading && !error && data && data.invite.status !== "PENDING" ? (
          <UnavailableCard
            icon={data.invite.status === "EXPIRED" ? TimerOff : ShieldX}
            // Known statuses get their own honest copy; an unknown future
            // status value degrades to the generic unavailable copy instead
            // of a missing-message formatting error.
            title={
              UNAVAILABLE_STATUSES.includes(data.invite.status)
                ? t(`join.unavailable.${data.invite.status}Title` as Parameters<typeof t>[0])
                : t("join.unavailable.invalidTitle")
            }
            body={
              UNAVAILABLE_STATUSES.includes(data.invite.status)
                ? t(`join.unavailable.${data.invite.status}Body` as Parameters<typeof t>[0])
                : t("join.unavailable.invalidBody")
            }
            ctaLabel={t("join.goAdminSignIn")}
            onCta={goAdminSignIn}
          />
        ) : null}

        {!isLoading && !error && data && data.invite.status === "PENDING" ? (
          <RedeemCard token={token} invite={data.invite} />
        ) : null}
      </div>
    </main>
  );
}

/* ------------------------------ loading state ----------------------------- */

function JoinSkeleton() {
  const t = useTranslations("platform");
  return (
    <Card className={glassCardClass} aria-busy="true" aria-label={t("join.loading")}>
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#C165DD]/60 to-transparent" />
      <CardHeader>
        <Skeleton className="mb-2 size-12 rounded-xl" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-11 w-full" />
      </CardContent>
    </Card>
  );
}

/* ---------------------------- unavailable states --------------------------- */

function UnavailableCard({
  icon: Icon,
  title,
  body,
  ctaLabel,
  onCta,
}: {
  icon: typeof ShieldX;
  title: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
}) {
  return (
    <Card className={glassCardClass} data-testid="pf-join-unavailable">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#C165DD]/60 to-transparent" />
      <CardHeader className="text-center">
        <div className="border-[#C165DD]/30 from-[#C165DD]/15 to-[#5C27FE]/15 mx-auto mb-2 flex size-12 items-center justify-center rounded-xl border bg-gradient-to-br">
          <Icon className="text-[#a13fd6] dark:text-[#C165DD] size-6" aria-hidden="true" />
        </div>
        <CardTitle data-testid="pf-join-unavailable-title">{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" className="w-full" onClick={onCta} data-testid="pf-join-go-signin">
          <ShieldCheck className="size-4" aria-hidden="true" />
          {ctaLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- form state ------------------------------- */

function PasswordVisibilityButton({
  show,
  onClick,
  labels,
}: {
  show: boolean;
  onClick: () => void;
  labels: { show: string; hide: string };
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={show ? labels.hide : labels.show}
      aria-pressed={show}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute end-1.5 top-1/2 -translate-y-1/2 rounded-md p-2 outline-none focus-visible:ring-2"
    >
      {show ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
    </button>
  );
}

function RedeemCard({ token, invite }: { token: string; invite: Preview }) {
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RedeemResult | null>(null);

  const pwLabels = { show: t("join.showPassword"), hide: t("join.hidePassword") };
  const existing = invite.accountExists;
  // New-account confirm matches only when a confirm was typed at all.
  const confirmOk = existing || confirm.length === 0 || confirm === password;
  const canSubmit = password.length > 0 && confirmOk && !submitting && !done;

  const goAdminSignIn = () => navigate({ kind: "platform", section: "overview" });

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await platformJoinService.redeem(token, { password });
      setDone({ role: res.role, accountCreated: res.accountCreated });
    } catch (e) {
      setError(describeError(e, t));
    } finally {
      setSubmitting(false);
    }
  };

  const inviterName = invite.inviter?.name ?? invite.inviter?.email ?? null;

  /* ----------------------------- success state ---------------------------- */
  if (done) {
    return (
      <Card className={glassCardClass} data-testid="pf-join-success">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#C165DD]/60 to-transparent" />
        <CardHeader className="text-center">
          <div className="border-[#C165DD]/30 from-[#C165DD]/15 to-[#5C27FE]/15 mx-auto mb-2 flex size-12 items-center justify-center rounded-xl border bg-gradient-to-br">
            <CheckCircle2 className="text-[#a13fd6] dark:text-[#C165DD] size-6" aria-hidden="true" />
          </div>
          <CardTitle data-testid="pf-join-success-title">{t("join.successTitle")}</CardTitle>
          <CardDescription>
            {done.accountCreated ? t("join.successCreated") : t("join.successBound")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="border-border/60 flex items-center justify-between gap-2 rounded-md border p-3">
            <span className="text-muted-foreground text-sm">{t("join.grantedRole")}</span>
            <Badge variant="outline" data-testid="pf-join-success-role">
              {t(`roles.${done.role}` as Parameters<typeof t>[0])}
            </Badge>
          </div>
          <p className="text-muted-foreground rounded-md border bg-muted/40 px-3 py-2 text-xs" data-testid="pf-join-mfa-note">
            <ShieldCheck className="me-1.5 inline size-3.5" aria-hidden="true" />
            {t("join.mfaNote")}
          </p>
          <Button className={`${PLATFORM_GRADIENT_CTA} w-full`} onClick={goAdminSignIn} data-testid="pf-join-go-signin-success">
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t("join.goAdminSignIn")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={glassCardClass} data-testid="pf-join-card">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#C165DD]/60 to-transparent" />
      <CardHeader>
        <div className="border-[#C165DD]/30 from-[#C165DD]/15 to-[#5C27FE]/15 mb-2 flex size-12 items-center justify-center rounded-xl border bg-gradient-to-br">
          <ShieldCheck className="text-[#a13fd6] dark:text-[#C165DD] size-6" aria-hidden="true" />
        </div>
        <CardTitle data-testid="pf-join-title">{t("join.title")}</CardTitle>
        <CardDescription>
          {inviterName
            ? t("join.descriptionInviter", {
                inviter: inviterName,
                role: t(`roles.${invite.role}` as Parameters<typeof t>[0]),
                date: formatDateTime(invite.expiresAt),
              })
            : t("join.description", {
                role: t(`roles.${invite.role}` as Parameters<typeof t>[0]),
                date: formatDateTime(invite.expiresAt),
              })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="border-border/60 bg-muted/40 space-y-3 rounded-md border p-3">
          <div className="space-y-1">
            <dt className="text-muted-foreground text-xs">{t("join.inviteeEmail")}</dt>
            <dd dir="ltr" className="font-mono text-sm font-medium break-all" data-testid="pf-join-email">
              {invite.email}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Mail className="size-3.5" aria-hidden="true" />
              {t("join.inviteeName")}
            </span>
            <span className="text-sm font-medium break-words" dir="auto">
              {invite.name}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">{t("join.grantedRole")}</span>
            <Badge variant="outline" data-testid="pf-join-role">
              {t(`roles.${invite.role}` as Parameters<typeof t>[0])}
            </Badge>
          </div>
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
            <span>{t("join.expiresLabel")}</span>
            <span className="tabular-nums">{formatDateTime(invite.expiresAt)}</span>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
          className="mt-4 space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="pf-join-password">
              {existing ? t("join.currentPasswordLabel") : t("join.newPasswordLabel")}
            </Label>
            <div className="relative">
              <Lock
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
              />
              <Input
                id="pf-join-password"
                type={showPassword ? "text" : "password"}
                autoComplete={existing ? "current-password" : "new-password"}
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="h-11 ps-9 pe-10"
                data-testid="pf-join-password"
              />
              <PasswordVisibilityButton
                show={showPassword}
                onClick={() => setShowPassword((v) => !v)}
                labels={pwLabels}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              {existing ? t("join.currentPasswordHint") : t("join.passwordPolicyHint")}
            </p>
          </div>

          {!existing ? (
            <div className="space-y-2">
              <Label htmlFor="pf-join-confirm">{t("join.confirmPasswordLabel")}</Label>
              <div className="relative">
                <Lock
                  aria-hidden="true"
                  className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
                />
                <Input
                  id="pf-join-confirm"
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  dir="ltr"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  className="h-11 ps-9 pe-10"
                  aria-invalid={!confirmOk}
                  data-testid="pf-join-confirm"
                />
                <PasswordVisibilityButton
                  show={showConfirm}
                  onClick={() => setShowConfirm((v) => !v)}
                  labels={pwLabels}
                />
              </div>
              {!confirmOk ? (
                <p className="text-destructive text-xs">{t("join.confirmMismatch")}</p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert" data-testid="pf-join-error">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className={`${PLATFORM_GRADIENT_CTA} h-11 w-full`}
            disabled={!canSubmit}
            data-testid="pf-join-submit"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-4" aria-hidden="true" />
            )}
            {submitting ? t("join.redeeming") : t("join.accept")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Local error mapping — this page is anonymous, so the platform error hook's
 * session-flavored copy is wrong; join.* carries its own honest copy. */
function describeError(
  e: unknown,
  t: ReturnType<typeof useTranslations>,
): string {
  if (e instanceof ApiClientError) {
    switch (e.code) {
      case "PLATFORM_INVITE_PASSWORD_MISMATCH":
        return t("join.errors.passwordMismatch");
      case "RATE_LIMITED":
      case "PLATFORM_RATE_LIMITED":
        return t("join.errors.rateLimited");
      case "VALIDATION_ERROR":
        return t("join.errors.invalidData");
      case "PLATFORM_INVITE_UNAVAILABLE":
      case "PLATFORM_INVITE_INVALID":
        return t("join.errors.unavailable");
      case "NETWORK_ERROR":
        return t("join.errors.network");
    }
  }
  return t("join.errors.generic");
}

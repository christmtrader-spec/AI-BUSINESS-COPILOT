"use client";

/**
 * Account Security Center — Prompt 30 §92-§107, §230-§257, §455-§465.
 *
 * Sections: Password · Email verification · MFA · Recovery codes ·
 * Sessions · Security activity. All state comes from the SERVER (§406 —
 * no localStorage authority); identity is the session (§127); destructive
 * flows use real step-up (password / MFA / typed confirmations, §118).
 *
 * Factual copy only (§456/§457): no fear patterns, no fake security
 * scores, no "fully protected" claims. Raw IPs are never shown (§98).
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut } from "next-auth/react";
import { useTranslations } from "next-intl";
import { create } from "zustand";
import {
  BadgeCheck,
  CircleAlert,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  MailCheck,
  MonitorSmartphone,
  Printer,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  History,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp";
import { PageHeader } from "@/components/shared/primitives";
import { useAppStore } from "@/store/app-store";

/* -------------------------- recovery-codes handoff -------------------------- */

/**
 * Tiny in-memory handoff so raw codes flow mutation → dialog without any
 * persistence (§354 — codes NEVER touch localStorage/sessionStorage).
 */
const useRecoveryCodesStore = create<{ codes: string[]; set: (c: string[]) => void }>()((set) => ({
  codes: [],
  set: (codes) => set({ codes }),
}));
export function handOffRecoveryCodes(codes: string[]) {
  useRecoveryCodesStore.getState().set(codes);
}

/* ------------------------------- DTO types -------------------------------- */

type SecuritySummary = {
  email: string;
  emailVerified: boolean;
  emailVerificationMode: "OFF" | "OPTIONAL" | "REQUIRED";
  mfaEnabled: boolean;
  recoveryCodeCount: number;
  currentSession: {
    id: string;
    deviceLabel: string | null;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    isCurrent: boolean;
    revoked: boolean;
  } | null;
  sessionCount: number;
  securityEventsSummary: { last30Days: number };
};

type SessionRow = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
  revoked: boolean;
};

type ActivityRow = {
  eventType: string;
  success: boolean;
  reasonCode: string | null;
  createdAt: string;
  deviceLabel: string | null;
};

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    const code = err.code;
    if (code === "INVALID_CURRENT_PASSWORD") return "errors.invalidPassword";
    if (code === "MFA_INVALID_CODE") return "errors.invalidCode";
    if (code === "MFA_CODE_REQUIRED") return "errors.mfaCodeRequired";
    if (code === "MFA_REAUTH_REQUIRED" || code === "MFA_DISABLE_REAUTH_REQUIRED") return "errors.reauthRequired";
    if (code === "RATE_LIMITED" || code === "MFA_RATE_LIMITED" || code === "EMAIL_VERIFICATION_RATE_LIMITED")
      return "errors.rateLimited";
    if (code === "SESSION_NOT_FOUND") return "errors.sessionNotFound";
    if (code === "SESSION_CURRENT") return "errors.sessionCurrent";
    if (code === "EMAIL_VERIFICATION_REQUIRED") return "errors.emailVerificationRequired";
  }
  return fallback;
}

function formatDateTime(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/* ------------------------------- main view --------------------------------- */

export function SecurityCenterView() {
  const t = useTranslations("security");
  const tCommon = useTranslations("common");
  const locale = useAppStore((s) => s.locale);
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();

  const summary = useQuery<SecuritySummary>({
    queryKey: ["security-summary"],
    queryFn: () => api("/api/v1/me/security", { businessId: null }),
  });
  const sessions = useQuery<{ sessions: SessionRow[]; currentSessionRegistered: boolean; total: number }>({
    queryKey: ["security-sessions"],
    queryFn: () => api("/api/v1/me/security/sessions?pageSize=50", { businessId: null }),
  });
  const activity = useQuery<{ events: ActivityRow[]; total: number }>({
    queryKey: ["security-activity"],
    queryFn: () => api("/api/v1/me/security/activity?pageSize=20", { businessId: null }),
  });

  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthMode, setReauthMode] = useState<"mfa-setup" | "mfa-disable" | "mfa-regen">("mfa-setup");
  const [setupOpen, setSetupOpen] = useState(false);
  const [recoveryCodesOpen, setRecoveryCodesOpen] = useState(false);
  /** §363 — only the SETUP flow invalidates all sessions (regen does not). */
  const signOutAfterCodesRef = useRef(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revokedSession, setRevokedSession] = useState<SessionRow | null>(null);

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["security-summary"] });
    void queryClient.invalidateQueries({ queryKey: ["security-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["security-activity"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  };

  const dialogProps = {
    reauthOpen,
    reauthMode,
    setupOpen,
    recoveryCodesOpen,
    disableOpen,
    regenOpen,
    revokeAllOpen,
    revokedSession,
    setReauthOpen,
    setSetupOpen,
    setRecoveryCodesOpen,
    setDisableOpen,
    setRegenOpen,
    setRevokeAllOpen,
    setRevokedSession,
    invalidateAll,
    onSetupEnabled: (codes: string[]) => {
      setSetupOpen(false);
      signOutAfterCodesRef.current = true;
      handOffRecoveryCodes(codes);
      setRecoveryCodesOpen(true);
      invalidateAll();
    },
    onRecoveryCodesDismissed: (o: boolean) => {
      setRecoveryCodesOpen(o);
      if (!o) {
        // §363 — after MFA enable every session is dead: dismiss the codes
        // and sign in again WITH the second factor.
        if (signOutAfterCodesRef.current) {
          signOutAfterCodesRef.current = false;
          void signOut({ callbackUrl: "/" });
        }
      }
    },
  };

  const summaryData = summary.data;
  const mfaAvailable =
    // Honest availability signal: the deployment must expose the capability.
    // When disabled server-side, setup returns MFA_NOT_CONFIGURED and the
    // UI surfaces the honest message; the button stays visible (§455 gentle
    // onboarding, not a fake error).
    true;

  if (summary.isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="flex items-center justify-center py-16" role="status">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        </div>
        {/* Dialogs stay mounted even during refetch storms (§60 — the
            one-time recovery-code display must never be torn down by a
            background 401). */}
        <AllDialogs
          {...dialogProps}
        />
      </div>
    );
  }
  if (summary.isError || !summaryData) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CircleAlert className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">{t("errors.generic")}</p>
            <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
              {tCommon("retry")}
            </Button>
          </CardContent>
        </Card>
        <AllDialogs {...dialogProps} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* ------------------------- Password (§93) ------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" aria-hidden />
            {t("passwordSection")}
          </CardTitle>
          <CardDescription>{t("passwordSectionDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t("lastPasswordChangeUnavailable")}</p>
          <Button variant="outline" size="sm" onClick={() => navigate({ kind: "profile" })}>
            {t("passwordChangeAction")}
          </Button>
        </CardContent>
      </Card>

      {/* ------------------- Email verification (§94) --------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MailCheck className="h-4 w-4 text-primary" aria-hidden />
            {t("emailSection")}
          </CardTitle>
          <CardDescription className="break-all">{summaryData.email}</CardDescription>
        </CardHeader>
        <EmailSection summary={summaryData} onChanged={invalidateAll} />
      </Card>

      {/* --------------------------- MFA (§95) ---------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {summaryData.mfaEnabled ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden />
            )}
            {t("mfaSection")}
            <Badge variant={summaryData.mfaEnabled ? "default" : "secondary"} className="ms-1">
              {summaryData.mfaEnabled ? t("mfaEnabled") : t("mfaDisabled")}
            </Badge>
          </CardTitle>
          <CardDescription>{t("mfaSectionDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {summaryData.mfaEnabled ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t("mfaRecoveryRemaining", { count: summaryData.recoveryCodeCount })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setRegenOpen(true)}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t("mfaRegenerateCodesAction")}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setDisableOpen(true)}>
                  <ShieldX className="h-4 w-4" aria-hidden />
                  {t("mfaDisableAction")}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{mfaAvailable ? t("mfaSectionDesc") : t("mfaUnavailable")}</p>
              <Button
                size="sm"
                disabled={!mfaAvailable}
                onClick={() => {
                  setReauthMode("mfa-setup");
                  setReauthOpen(true);
                }}
              >
                {t("mfaEnableAction")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----------------------- Sessions (§96) --------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone className="h-4 w-4 text-primary" aria-hidden />
            {t("sessionsSection")}
          </CardTitle>
          <CardDescription>{t("sessionsSectionDesc")}</CardDescription>
        </CardHeader>
        <SessionsSection
          sessions={sessions.data?.sessions ?? []}
          currentRegistered={sessions.data?.currentSessionRegistered ?? true}
          isLoading={sessions.isLoading}
          locale={locale}
          onRevokeAll={() => setRevokeAllOpen(true)}
          onRevoke={(s) => setRevokedSession(s)}
          onChanged={invalidateAll}
        />
      </Card>

      {/* ----------------------- Activity (§97) --------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" aria-hidden />
            {t("activitySection")}
          </CardTitle>
          <CardDescription>{t("activitySectionDesc")}</CardDescription>
        </CardHeader>
        <ActivitySection
          events={activity.data?.events ?? []}
          isLoading={activity.isLoading}
          locale={locale}
        />
      </Card>

      {/* ------------------------------ activity --------------------------- */}
      <ActivitySection
        events={activity.data?.events ?? []}
        isLoading={activity.isLoading}
        locale={locale}
      />

      <AllDialogs {...dialogProps} />
    </div>
  );
}


/** All security-center dialogs, hoisted so they stay mounted regardless of
 * the summary query state — the one-time recovery-code display (§60) must
 * never be torn down by a background refetch. */
type DialogProps = {
  reauthOpen: boolean;
  reauthMode: "mfa-setup" | "mfa-disable" | "mfa-regen";
  setupOpen: boolean;
  recoveryCodesOpen: boolean;
  disableOpen: boolean;
  regenOpen: boolean;
  revokeAllOpen: boolean;
  revokedSession: SessionRow | null;
  setReauthOpen: (o: boolean) => void;
  setSetupOpen: (o: boolean) => void;
  setRecoveryCodesOpen: (o: boolean) => void;
  setDisableOpen: (o: boolean) => void;
  setRegenOpen: (o: boolean) => void;
  setRevokeAllOpen: (o: boolean) => void;
  setRevokedSession: (s: SessionRow | null) => void;
  invalidateAll: () => void;
  onSetupEnabled: (recoveryCodes: string[]) => void;
  onRecoveryCodesDismissed: (open: boolean) => void;
};

function AllDialogs(props: DialogProps) {
  return (
    <>
      <ReauthDialog
        open={props.reauthOpen}
        onOpenChange={props.setReauthOpen}
        mfaEnabled={false}
        onSuccess={() => {
          props.setReauthOpen(false);
          if (props.reauthMode === "mfa-setup") props.setSetupOpen(true);
        }}
      />
      <MfaSetupDialog
        open={props.setupOpen}
        onOpenChange={props.setSetupOpen}
        onEnabled={props.onSetupEnabled}
      />
      <RecoveryCodesDialog
        open={props.recoveryCodesOpen}
        onOpenChange={(o) => props.onRecoveryCodesDismissed(o)}
      />
      <MfaDisableDialog
        open={props.disableOpen}
        onOpenChange={props.setDisableOpen}
        onDisabled={() => {
          props.setDisableOpen(false);
          // §66 — all devices signed out; this one included.
          void signOut({ callbackUrl: "/" });
        }}
      />
      <MfaRegenDialog
        open={props.regenOpen}
        onOpenChange={props.setRegenOpen}
        onRegenerated={(codes) => {
          props.setRegenOpen(false);
          handOffRecoveryCodes(codes);
          props.setRecoveryCodesOpen(true);
          props.invalidateAll();
        }}
      />
      <RevokeAllDialog
        open={props.revokeAllOpen}
        onOpenChange={props.setRevokeAllOpen}
        onChanged={props.invalidateAll}
      />
      <RevokeOneDialog
        session={props.revokedSession}
        onClose={() => props.setRevokedSession(null)}
        onChanged={props.invalidateAll}
      />
    </>
  );
}

/* ----------------------------- email section ------------------------------- */

function EmailSection({
  summary,
  onChanged,
}: {
  summary: SecuritySummary;
  onChanged: () => void;
}) {
  const t = useTranslations("security");
  const [pending, setPending] = useState(false);

  const resend = useMutation({
    mutationFn: async () =>
      api<{ sent: boolean; alreadyVerified: boolean }>("/api/v1/auth/email-verification/resend", {
        method: "POST",
        businessId: null,
      }),
    onMutate: () => setPending(true),
    onSettled: () => setPending(false),
    onSuccess: (res) => {
      if (res.alreadyVerified) {
        toast({ title: t("emailAlreadyVerified") });
      } else if (res.sent) {
        toast({ title: t("emailResendSent") });
        onChanged();
      } else {
        toast({ title: t("emailResendFailed"), variant: "destructive" });
      }
    },
    onError: (err) => {
      toast({
        title: t(errText(err, "emailResendFailed")),
        variant: "destructive",
      });
    },
  });

  const modeOff = summary.emailVerificationMode === "OFF";

  return (
    <CardContent className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {summary.emailVerified ? (
          <Badge className="gap-1" variant="default">
            <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
            {t("emailVerified")}
          </Badge>
        ) : (
          <Badge className="gap-1" variant="outline">
            <CircleAlert className="h-3.5 w-3.5" aria-hidden />
            {t("emailNotVerified")}
          </Badge>
        )}
        {!summary.emailVerified && !modeOff ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => resend.mutate()}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("emailResendAction")}
          </Button>
        ) : null}
      </div>
      {modeOff && !summary.emailVerified ? (
        <p className="text-xs text-muted-foreground">{t("emailModeOff")}</p>
      ) : null}
    </CardContent>
  );
}

/* ---------------------------- reauth dialog ------------------------------- */

function ReauthDialog({
  open,
  onOpenChange,
  mfaEnabled,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mfaEnabled: boolean;
  onSuccess: () => void;
}) {
  const t = useTranslations("security");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reauth = useMutation({
    mutationFn: async () =>
      api<{ passwordVerified: boolean; mfaVerified: boolean; windowSeconds: number }>(
        "/api/v1/me/security/reauth",
        { method: "POST", body: JSON.stringify({ password, ...(mfaCode ? { mfaCode } : {}) }), businessId: null },
      ),
    onSuccess: () => {
      setPassword("");
      setMfaCode("");
      setError(null);
      onSuccess();
    },
    onError: (err) => {
      setError(t(errText(err, "errors.generic")));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("mfaReauthTitle")}</DialogTitle>
          <DialogDescription>{t("mfaReauthSuccess")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reauth-password">{t("mfaReauthPassword")}</Label>
            <Input
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {mfaEnabled ? (
            <div className="space-y-2">
              <Label htmlFor="reauth-code">{t("mfaReauthCode")}</Label>
              <InputOTP maxLength={6} value={mfaCode} onChange={setMfaCode}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("mfaRecoveryDone")}
          </Button>
          <Button
            disabled={reauth.isPending || password.length === 0}
            onClick={() => reauth.mutate()}
          >
            {reauth.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("mfaReauthSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------- MFA setup dialog ---------------------------- */

function MfaSetupDialog({
  open,
  onOpenChange,
  onEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the ONE-TIME recovery codes after successful enable. */
  onEnabled: (recoveryCodes: string[]) => void;
}) {
  const t = useTranslations("security");
  const [stage, setStage] = useState<"start" | "confirm">("start");
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmedSaved, setConfirmedSaved] = useState(false);

  const start = useMutation({
    mutationFn: async () =>
      api<{ otpauthUri: string; manualKey: string; qrDataUri: string }>(
        "/api/v1/me/security/mfa/setup/start",
        { method: "POST", businessId: null },
      ),
    onSuccess: (res) => {
      setUri(res.otpauthUri);
      setQr(res.qrDataUri);
      setManualKey(res.manualKey);
      setStage("confirm");
    },
    onError: (err) => {
      setError(t(errText(err, "errors.generic")));
    },
  });

  const confirm = useMutation({
    mutationFn: async () =>
      api<{ enabled: boolean; recoveryCodes: string[]; sessionsInvalidated: boolean }>(
        "/api/v1/me/security/mfa/setup/confirm",
        { method: "POST", body: JSON.stringify({ code, confirmedSaved: true }), businessId: null },
      ),
    onSuccess: (res) => {
      setCode("");
      setError(null);
      onEnabled(res.recoveryCodes);
      setStage("start");
    },
    onError: (err) => {
      setError(t(errText(err, "errors.generic")));
    },
  });

  const close = (o: boolean) => {
    if (!o) {
      // §106 — abandoning setup leaves no usable server state (the pending
      // row is replaced/overwritten on a future setup and dies by TTL).
      setStage("start");
      setUri(null);
      setQr(null);
      setManualKey("");
      setCode("");
      setConfirmedSaved(false);
      setError(null);
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("mfaSetupTitle")}</DialogTitle>
          <DialogDescription>{t("mfaSetupStep1")}</DialogDescription>
        </DialogHeader>
        {stage === "start" ? (
          <div className="flex flex-col items-center gap-3 py-2">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t("mfaEnableAction")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2">
              {qr ? (
                // §41/§287 — server-generated PNG data URI; no third-party
                // service, no secret in any URL, nothing logged.
                <img src={qr} alt={t("mfaSetupTitle")} className="rounded-lg border bg-white p-1" width={200} height={200} />
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>{t("mfaSetupManualKey")}</Label>
              <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs" dir="ltr">
                {manualKey}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("mfaSetupStep2")}</Label>
              <InputOTP maxLength={6} value={code} onChange={setCode}>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {t("mfaRecoveryDone")}
          </Button>
          {stage === "start" ? (
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t("mfaEnableAction")}
            </Button>
          ) : (
            <Button
              disabled={confirm.isPending || code.length !== 6 || !confirmedSaved}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {t("mfaSetupConfirm")}
            </Button>
          )}
        </DialogFooter>
        {stage === "confirm" ? (
          <div className="flex items-center gap-2">
            <input
              id="confirmed-saved"
              type="checkbox"
              checked={confirmedSaved}
              onChange={(e) => setConfirmedSaved(e.target.checked)}
              className="h-4 w-4"
            />
            <Label htmlFor="confirmed-saved" className="text-xs font-normal text-muted-foreground">
              {t("mfaRecoverySavedConfirm")}
            </Label>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------- recovery codes dialog -------------------------- */

function RecoveryCodesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("security");
  const tCommon = useTranslations("common");
  const codes = useRecoveryCodesStore((s) => s.codes);

  const copyAll = () => {
    void navigator.clipboard.writeText(codes.join("\n"));
    toast({ title: tCommon("copied") });
  };
  const printCodes = () => {
    // §463 — explicit user action only; never auto-triggered.
    const w = window.open("", "_blank", "width=600,height=700");
    if (w) {
      w.document.write(
        `<html><head><title>${t("mfaRecoveryCodesTitle")}</title></head><body style="font-family:system-ui;padding:24px"><h1>${t("mfaRecoveryCodesTitle")}</h1><pre style="font-size:14px;line-height:2">${codes.join("\n")}</pre><p>${t("mfaRecoveryWarning")}</p></body></html>`,
      );
      w.document.close();
      w.focus();
      w.print();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            {t("mfaRecoveryCodesTitle")}
          </DialogTitle>
          <DialogDescription>{t("mfaRecoveryCodesDesc")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3">
          <ul className="grid grid-cols-2 gap-2" dir="ltr">
            {codes.map((code) => (
              <li key={code} className="font-mono text-sm tracking-wider">
                {code}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">{t("mfaRecoveryWarning")}</p>
        </div>
        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={copyAll} disabled={codes.length === 0}>
              <Copy className="h-4 w-4" aria-hidden />
              {t("mfaCopyAllAction")}
            </Button>
            <Button variant="outline" size="sm" onClick={printCodes} disabled={codes.length === 0}>
              <Printer className="h-4 w-4" aria-hidden />
              {t("mfaPrintAction")}
            </Button>
          </div>
          <Button onClick={() => onOpenChange(false)}>{t("mfaRecoveryDone")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------- MFA disable dialog --------------------------- */

function MfaDisableDialog({
  open,
  onOpenChange,
  onDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabled: () => void;
}) {
  const t = useTranslations("security");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const disable = useMutation({
    mutationFn: async () =>
      api<{ disabled: boolean; sessionsInvalidated: boolean }>("/api/v1/me/security/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ password, mfaCode: code, confirmation }),
        businessId: null,
      }),
    onSuccess: () => {
      setPassword("");
      setCode("");
      setConfirmation("");
      setError(null);
      onDisabled();
    },
    onError: (err) => setError(t(errText(err, "errors.generic"))),
  });

  const close = (o: boolean) => {
    if (!o) {
      setPassword("");
      setCode("");
      setConfirmation("");
      setError(null);
    }
    onOpenChange(o);
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldX className="h-4 w-4 text-destructive" aria-hidden />
            {t("mfaDisableTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("mfaDisableDesc")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mfa-disable-password">{t("mfaReauthPassword")}</Label>
            <Input
              id="mfa-disable-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("mfaReauthCode")}</Label>
            <InputOTP maxLength={6} value={code} onChange={setCode}>
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mfa-disable-confirm">{t("mfaDisableConfirmLabel")}</Label>
            <Input
              id="mfa-disable-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("mfaRecoveryDone")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={disable.isPending || !password || code.length !== 6 || confirmation !== "DISABLE MFA"}
            onClick={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            {disable.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("mfaDisableAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* --------------------------- regenerate codes ------------------------------ */

function MfaRegenDialog({
  open,
  onOpenChange,
  onRegenerated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegenerated: (recoveryCodes: string[]) => void;
}) {
  const t = useTranslations("security");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const regen = useMutation({
    mutationFn: async () =>
      api<{ recoveryCodes: string[] }>("/api/v1/me/security/mfa/recovery-codes/regenerate", {
        method: "POST",
        body: JSON.stringify({ password, mfaCode: code }),
        businessId: null,
      }),
    onSuccess: (res) => {
      setPassword("");
      setCode("");
      setError(null);
      onRegenerated(res.recoveryCodes);
    },
    onError: (err) => setError(t(errText(err, "errors.generic"))),
  });

  const close = (o: boolean) => {
    if (!o) {
      setPassword("");
      setCode("");
      setError(null);
    }
    onOpenChange(o);
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("mfaRecoveryRegenTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("mfaRecoveryRegenDesc")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="regen-password">{t("mfaReauthPassword")}</Label>
            <Input
              id="regen-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("mfaReauthCode")}</Label>
            <InputOTP maxLength={6} value={code} onChange={setCode}>
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("mfaRecoveryDone")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={regen.isPending || !password || code.length !== 6}
            onClick={(e) => {
              e.preventDefault();
              regen.mutate();
            }}
          >
            {regen.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("mfaRegenerateCodesAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ------------------------------ sessions ----------------------------------- */

function SessionsSection({
  sessions,
  currentRegistered,
  isLoading,
  locale,
  onRevokeAll,
  onRevoke,
  onChanged,
}: {
  sessions: SessionRow[];
  currentRegistered: boolean;
  isLoading: boolean;
  locale: string;
  onRevokeAll: () => void;
  onRevoke: (s: SessionRow) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("security");
  void onChanged;
  const active = sessions.filter((s) => !s.revoked);

  if (isLoading) {
    return (
      <CardContent className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
      </CardContent>
    );
  }

  return (
    <CardContent className="space-y-3">
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("sessionsEmpty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {active.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{s.deviceLabel ?? t("sessionsUnknownDevice")}</span>
                  {s.isCurrent ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t("sessionsCurrentBadge")}
                    </Badge>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("sessionsLastActive")}: {formatDateTime(s.lastSeenAt, locale)} · {t("sessionsCreated")}:{" "}
                  {formatDateTime(s.createdAt, locale)}
                </p>
              </div>
              {!s.isCurrent ? (
                <Button variant="outline" size="sm" onClick={() => onRevoke(s)}>
                  {t("sessionsRevokeAction")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!currentRegistered ? (
        <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
          {t("sessionsCurrentUnknown")}
        </p>
      ) : null}
      {active.length > 1 ? (
        <Button variant="outline" size="sm" onClick={onRevokeAll}>
          {t("sessionsRevokeAllAction")}
        </Button>
      ) : null}
    </CardContent>
  );
}

function RevokeOneDialog({
  session,
  onClose,
  onChanged,
}: {
  session: SessionRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("security");
  const [error, setError] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: async (id: string) =>
      api<{ revoked: boolean; alreadyRevoked: boolean }>(`/api/v1/me/security/sessions/${id}/revoke`, {
        method: "POST",
        businessId: null,
      }),
    onSuccess: () => {
      toast({ title: t("sessionsRevokedToast") });
      onChanged();
      onClose();
    },
    onError: (err) => setError(t(errText(err, "errors.generic"))),
  });

  return (
    <AlertDialog
      open={session !== null}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sessionsRevokeConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("sessionsRevokeConfirmBody", {
              device: session?.deviceLabel ?? t("sessionsUnknownDevice"),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("mfaRecoveryDone")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={(e) => {
              e.preventDefault();
              if (session) revoke.mutate(session.id);
            }}
          >
            {revoke.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("sessionsRevokeAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RevokeAllDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("security");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const revokeAll = useMutation({
    mutationFn: async () =>
      api<{ revokedCount: number }>("/api/v1/me/security/sessions/revoke-all", {
        method: "POST",
        body: JSON.stringify({ password, confirmation }),
        businessId: null,
      }),
    onSuccess: (res) => {
      toast({ title: t("sessionsRevokeAllToast", { count: res.revokedCount }) });
      setPassword("");
      setConfirmation("");
      setError(null);
      onChanged();
      onOpenChange(false);
    },
    onError: (err) => setError(t(errText(err, "errors.generic"))),
  });

  const close = (o: boolean) => {
    if (!o) {
      setPassword("");
      setConfirmation("");
      setError(null);
    }
    onOpenChange(o);
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sessionsRevokeAllTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("sessionsRevokeAllBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="revoke-all-password">{t("mfaReauthPassword")}</Label>
            <Input
              id="revoke-all-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="revoke-all-confirm">{t("sessionsRevokeAllConfirmLabel")}</Label>
            <Input
              id="revoke-all-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("mfaRecoveryDone")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={revokeAll.isPending || !password || confirmation !== "SIGN OUT ALL"}
            onClick={(e) => {
              e.preventDefault();
              revokeAll.mutate();
            }}
          >
            {revokeAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("sessionsRevokeAllAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ------------------------------- activity ---------------------------------- */

/** Fixed map from the SecurityEvent vocabulary (§423) onto next-intl keys —
 * dots are not allowed inside i18n keys, so the static map avoids any
 * dynamic-key validation at runtime. Unknown event types render raw. */
const ACTIVITY_LABEL_KEYS: Record<string, Parameters<typeof useTranslations<"security">>[0] extends never ? never : string> = {
  "auth.login.success": "activityEvent.auth_login_success",
  "auth.login.failed": "activityEvent.auth_login_failed",
  "auth.logout": "activityEvent.auth_logout",
  "auth.session.revoked": "activityEvent.auth_session_revoked",
  "auth.session.revoked_all": "activityEvent.auth_session_revoked_all",
  "auth.mfa.enrollment_started": "activityEvent.auth_mfa_enrollment_started",
  "auth.mfa.enabled": "activityEvent.auth_mfa_enabled",
  "auth.mfa.disabled": "activityEvent.auth_mfa_disabled",
  "auth.mfa.recovery_codes_generated": "activityEvent.auth_mfa_recovery_codes_generated",
  "auth.mfa.recovery_code_used": "activityEvent.auth_mfa_recovery_code_used",
  "auth.mfa.login_challenge_created": "activityEvent.auth_mfa_login_challenge_created",
  "auth.mfa.login_succeeded": "activityEvent.auth_mfa_login_succeeded",
  "auth.mfa.login_failed": "activityEvent.auth_mfa_login_failed",
  "auth.email_verification.requested": "activityEvent.auth_email_verification_requested",
  "auth.email_verification.sent": "activityEvent.auth_email_verification_sent",
  "auth.email_verification.completed": "activityEvent.auth_email_verification_completed",
  "auth.email_verification.failed": "activityEvent.auth_email_verification_failed",
  "auth.password.changed": "activityEvent.auth_password_changed",
  "auth.password.reset_completed": "activityEvent.auth_password_reset_completed",
  "auth.stepup.password_verified": "activityEvent.auth_stepup_password_verified",
  "auth.stepup.mfa_verified": "activityEvent.auth_stepup_mfa_verified",
};

function labelForEvent(
  t: ReturnType<typeof useTranslations<"security">>,
  eventType: string,
): string {
  const key = ACTIVITY_LABEL_KEYS[eventType];
  if (!key) return eventType;
  // The map is statically aligned with the message files; the cast keeps the
  // dynamic lookup type-safe at the boundary.
  return (t as unknown as (k: string) => string)(key);
}

function ActivitySection({
  events,
  isLoading,
  locale,
}: {
  events: ActivityRow[];
  isLoading: boolean;
  locale: string;
}) {
  const t = useTranslations("security");

  if (isLoading) {
    return (
      <CardContent className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
      </CardContent>
    );
  }

  if (events.length === 0) {
    return (
      <CardContent>
        <p className="text-sm text-muted-foreground">{t("activityEmpty")}</p>
      </CardContent>
    );
  }

  return (
    <CardContent>
      <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
        {events.map((event, i) => (
          <li key={`${event.eventType}-${event.createdAt}-${i}`} className="flex items-center justify-between gap-2 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm">
                {labelForEvent(t, event.eventType)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(event.createdAt, locale)}
                {event.deviceLabel ? ` · ${event.deviceLabel}` : ""}
              </p>
            </div>
            {!event.success ? (
              <Badge variant="destructive" className="shrink-0">
                {t("activityFailure")}
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </CardContent>
  );
}

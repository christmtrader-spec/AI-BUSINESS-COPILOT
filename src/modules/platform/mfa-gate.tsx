"use client";

/**
 * MFA gate + enrollment — Prompt 65 §6.2 (R65-UI).
 *
 * When the platform chain fail-closes an operator for missing MFA
 * (PLATFORM_MFA_REQUIRED), this screen replaces the console: an AMBER
 * (not red) policy notice with the honest enrollment path —
 * reauth → QR/manual key → 6-digit confirm → recovery codes shown EXACTLY
 * ONCE (§60) behind an "I saved my codes" checkbox → Finish. Enabling MFA
 * kills ALL sessions server-side (§363), so Finish ends in an honest
 * "session ended" state and a fresh sign-in. If the deployment has no MFA
 * capability (MFA_NOT_CONFIGURED) the gate stays BLOCKED with contact-admin
 * copy — never a fake green, never a fake enrollment UI (§184/§34).
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/store/app-store";
import { signOutWithRevoke } from "@/lib/sign-out-with-revoke";
import { ApiClientError } from "@/lib/api-client";
// R67 — brand CTA paint for the platform's own primary action. The amber
// gate (policy warning) + destructive/amber semantics stay untouched —
// only the BRAND surface (the enroll CTA) carries the gradient.
import { PLATFORM_GRADIENT_CTA } from "./kit";
import { platformSelfService } from "./platform-api";

type Setup = { otpauthUri: string; manualKey: string; qrDataUri: string };

export function MfaGateScreen() {
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Honest BLOCKED state — the deployment lacks MFA capability (§184).
  const [blocked, setBlocked] = useState(false);

  return (
    <main className="bg-background flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-md" data-testid="pf-mfa-gate">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/15">
            <ShieldAlert className="size-5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
          </div>
          <CardTitle>{blocked ? t("mfaGate.blockedTitle") : t("mfaGate.title")}</CardTitle>
          <CardDescription>
            {blocked ? t("mfaGate.blockedBody") : t("mfaGate.body")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {!blocked ? (
            <Button
              data-testid="pf-mfa-enroll"
              className={PLATFORM_GRADIENT_CTA}
              onClick={() => setDialogOpen(true)}
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              {t("mfaGate.enrollNow")}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => navigate({ kind: "dashboard" })}>
            <ArrowUpRight className="size-4" aria-hidden="true" />
            {t("backToWorkspace")}
          </Button>
        </CardContent>
      </Card>

      <MfaEnrollmentDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            // Leaving the flow with MFA still off keeps the gate honest —
            // re-probe so a mid-flight server change is reflected.
            void queryClient.invalidateQueries({ queryKey: ["platform", "self"] });
          }
        }}
        onBlocked={() => {
          setDialogOpen(false);
          setBlocked(true);
        }}
      />
    </main>
  );
}

type Step = "reauth" | "scan" | "confirm" | "codes" | "done";

function MfaEnrollmentDialog({
  open,
  onOpenChange,
  onBlocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBlocked: () => void;
}) {
  const t = useTranslations("platform");
  const [step, setStep] = useState<Step>("reauth");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  // §60 — the codes are shown exactly once; saving them is EXPLICIT.
  const [readyForCodes, setReadyForCodes] = useState(false);
  const [codesSaved, setCodesSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reauth/scan/confirm are freely dismissible; once the one-time codes are
  // on screen (or the session is already dead) the dialog must NOT be
  // dismissed silently — the only exits are Finish → Sign in again.
  const lockClose = step === "codes" || step === "done";

  const describeError = (e: unknown): string => {
    if (e instanceof ApiClientError) {
      switch (e.code) {
        case "INVALID_CURRENT_PASSWORD":
          return t("mfaGate.invalidPassword");
        case "MFA_REAUTH_REQUIRED":
          return t("mfaGate.reauthRequired");
        case "MFA_ALREADY_ENABLED":
          return t("mfaGate.alreadyEnabled");
        case "MFA_INVALID_CODE":
          return t("mfaGate.invalidCode");
        case "MFA_CHALLENGE_EXPIRED":
        case "MFA_CHALLENGE_INVALID":
          return t("mfaGate.challengeExpired");
        case "MFA_RATE_LIMITED":
        case "RATE_LIMITED":
          return t("mfaGate.rateLimited");
      }
      if (e.status === 0) return t("mfaGate.genericError");
    }
    return t("mfaGate.genericError");
  };

  const reset = () => {
    setStep("reauth");
    setPassword("");
    setCode("");
    setSetup(null);
    setRecoveryCodes([]);
    setReadyForCodes(false);
    setCodesSaved(false);
    setError(null);
  };

  const runSetupStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await platformSelfService.mfaSetupStart();
      setSetup(res);
      setStep("scan");
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === "MFA_NOT_CONFIGURED") {
          // Honest BLOCKED: no enrollment UI is offered at all (§184).
          onBlocked();
          return;
        }
        if (e.code === "MFA_REAUTH_REQUIRED") {
          setStep("reauth");
          setError(t("mfaGate.reauthRequired"));
          return;
        }
        if (e.code === "MFA_ALREADY_ENABLED") {
          setStep("reauth");
          setError(t("mfaGate.alreadyEnabled"));
          return;
        }
      }
      setError(describeError(e));
    } finally {
      setStarting(false);
    }
  };

  const submitReauth = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await platformSelfService.reauth({ password });
      setPassword("");
      await runSetupStart();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const submitConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await platformSelfService.mfaSetupConfirm({ code, confirmedSaved: true });
      setRecoveryCodes(res.recoveryCodes);
      setCode("");
      setStep("codes");
    } catch (e) {
      if (e instanceof ApiClientError && (e.code === "MFA_INVALID_CODE" || e.code === "MFA_CHALLENGE_EXPIRED" || e.code === "MFA_CHALLENGE_INVALID")) {
        setError(describeError(e));
        if (e.code === "MFA_INVALID_CODE") setCode("");
        return;
      }
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  // One honest exit: reset the whole flow state AND close, so reopening
  // always starts from the reauth step (never a stale secret on screen).
  const close = () => {
    reset();
    onOpenChange(false);
  };

  const stepTitle: Record<Step, string> = {
    reauth: t("mfaGate.dialogTitle"),
    scan: t("mfaGate.stepScanTitle"),
    confirm: t("mfaGate.stepConfirmTitle"),
    codes: t("mfaGate.recoveryTitle"),
    done: t("mfaGate.sessionEndedTitle"),
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && lockClose) return; // no silent exit past the one-time codes
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-md"
        showCloseButton={!lockClose}
        data-testid="pf-mfa-dialog"
      >
        <DialogHeader>
          <DialogTitle>{stepTitle[step]}</DialogTitle>
          <DialogDescription>
            {step === "reauth" ? t("mfaGate.stepReauthDesc") : null}
            {step === "scan" ? t("mfaGate.stepScanDesc") : null}
            {step === "confirm" ? t("mfaGate.stepConfirmDesc") : null}
            {step === "codes" ? t("mfaGate.recoveryDesc") : null}
            {step === "done" ? t("mfaGate.sessionEndedBody") : null}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1 — reauth (§162): the password opens the recent-auth window. */}
        {step === "reauth" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pf-mfa-password">{t("dialogs.currentPassword")}</Label>
              <Input
                id="pf-mfa-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                data-testid="pf-mfa-password"
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Step 2 — scan: QR + manual key, shown once, never logged (§40). */}
        {step === "scan" ? (
          <div className="space-y-4">
            {starting || !setup ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("common.working")}
              </div>
            ) : (
              <>
                {/* White mat so the QR stays scannable in dark mode. */}
                <img
                  src={setup.qrDataUri}
                  alt={t("mfaGate.qrAlt")}
                  width={200}
                  height={200}
                  className="mx-auto rounded-md border bg-white p-2"
                  data-testid="pf-mfa-qr"
                />
                <div className="space-y-1.5">
                  <Label htmlFor="pf-mfa-manual-key">
                    <KeyRound className="me-1 inline size-3.5" aria-hidden="true" />
                    {t("mfaGate.manualKeyLabel")}
                  </Label>
                  <p
                    id="pf-mfa-manual-key"
                    className="font-mono bg-muted/50 rounded-md border p-2 text-xs break-all select-all"
                    dir="ltr"
                    data-testid="pf-mfa-manual-key"
                  >
                    {setup.manualKey}
                  </p>
                </div>
              </>
            )}
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Step 3 — confirm: first TOTP code. The acknowledgement checkbox
            mirrors the server's confirmedSaved literal (§60) — the recovery
            codes WILL be shown exactly once right after this. */}
        {step === "confirm" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pf-mfa-code">{t("mfaGate.codeLabel")}</Label>
              <InputOTP maxLength={6} value={code} onChange={setCode}>
                <InputOTPGroup dir="ltr">
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup dir="ltr">
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <label className="text-muted-foreground flex items-start gap-2 text-xs leading-5">
              <Checkbox
                checked={readyForCodes}
                onCheckedChange={(v) => setReadyForCodes(v === true)}
                className="mt-0.5"
                data-testid="pf-mfa-ready"
              />
              <span>{t("mfaGate.savedAck")}</span>
            </label>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Step 4 — recovery codes: EXACTLY ONCE (§60/§104), gated Finish. */}
        {step === "codes" ? (
          <div className="space-y-4">
            <ul
              className="grid grid-cols-2 gap-1.5"
              data-testid="pf-mfa-codes"
              aria-label={t("mfaGate.recoveryTitle")}
            >
              {recoveryCodes.map((c) => (
                <li
                  key={c}
                  className="font-mono bg-muted/50 rounded-md border px-2 py-1.5 text-center text-xs select-all"
                  dir="ltr"
                >
                  {c}
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-sm leading-5">
              <Checkbox
                checked={codesSaved}
                onCheckedChange={(v) => setCodesSaved(v === true)}
                className="mt-0.5"
                data-testid="pf-mfa-saved"
              />
              <span>{t("mfaGate.savedCheckbox")}</span>
            </label>
          </div>
        ) : null}

        {/* Step 5 — honest session end: enabling MFA killed ALL sessions
            server-side (§363); this console's session is already dead. */}
        {step === "done" ? (
          <div className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 space-y-2 rounded-md border p-3 text-sm" data-testid="pf-mfa-session-ended">
            <p className="flex items-center gap-1.5 font-medium">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              {t("mfaGate.sessionEndedTitle")}
            </p>
            <p className="text-muted-foreground text-xs">{t("mfaGate.sessionEndedNote")}</p>
          </div>
        ) : null}

        <DialogFooter className="flex-wrap gap-2">
          {step === "reauth" ? (
            <>
              <Button
                variant="outline"
                onClick={close}
                disabled={submitting}
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={password.length === 0 || submitting}
                onClick={() => void submitReauth()}
                data-testid="pf-mfa-reauth"
              >
                {submitting ? t("common.working") : t("mfaGate.continue")}
              </Button>
            </>
          ) : null}
          {step === "scan" ? (
            <>
              <Button variant="outline" onClick={close} disabled={starting}>
                {t("common.cancel")}
              </Button>
              <Button disabled={!setup || starting} onClick={() => setStep("confirm")}>
                {t("mfaGate.continue")}
              </Button>
            </>
          ) : null}
          {step === "confirm" ? (
            <>
              <Button
                variant="outline"
                onClick={() => void runSetupStart()}
                disabled={submitting || starting}
              >
                {t("mfaGate.startOver")}
              </Button>
              <Button
                disabled={code.length < 6 || !readyForCodes || submitting}
                onClick={() => void submitConfirm()}
                data-testid="pf-mfa-confirm"
              >
                {submitting ? t("common.working") : t("mfaGate.confirmBtn")}
              </Button>
            </>
          ) : null}
          {step === "codes" ? (
            <Button disabled={!codesSaved} onClick={() => setStep("done")} data-testid="pf-mfa-finish">
              {t("mfaGate.finish")}
            </Button>
          ) : null}
          {step === "done" ? (
            <Button onClick={() => void signOutWithRevoke("/")} data-testid="pf-mfa-signin-again">
              <ArrowUpRight className="size-4" aria-hidden="true" />
              {t("mfaGate.signInAgain")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

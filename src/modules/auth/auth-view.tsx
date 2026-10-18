"use client";

import { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { KeyRound, Loader2, LogIn, MailCheck, ShieldCheck, Sparkles, UserPlus, TrendingUp } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from "@/components/ui/input-otp";

type AuthErrors = {
  invalidCredentials: string;
  rateLimited: string;
  emailTaken: string;
  passwordMismatch: string;
  passwordPolicy: string;
  invalidData: string;
  network: string;
  generic: string;
};

/**
 * Server 422 envelopes carry the zod issues in `details`. When the failed
 * field is the password we can give the user the REAL reason instead of a
 * generic "try again" (BUGFIX P51-R1: signup showed a useless generic error
 * when the password policy rejected the submitted password).
 */
function hasValidationPath(details: unknown, field: string): boolean {
  if (!Array.isArray(details)) return false;
  return details.some(
    (issue) =>
      issue !== null &&
      typeof issue === "object" &&
      Array.isArray((issue as { path?: unknown }).path) &&
      (issue as { path: unknown[] }).path[0] === field,
  );
}

function mapSignInError(error: string | null | undefined, t: AuthErrors): string {
  if (error === "CredentialsSignin") return t.invalidCredentials;
  return t.generic;
}

function mapApiError(err: unknown, t: AuthErrors): string {
  if (err instanceof ApiClientError) {
    if (err.status === 0) return t.network;
    if (err.code === "EMAIL_TAKEN") return t.emailTaken;
    if (err.code === "RATE_LIMITED") return t.rateLimited;
    if (err.code === "VALIDATION_ERROR") {
      if (hasValidationPath(err.details, "password")) return t.passwordPolicy;
      return t.invalidData;
    }
  }
  return t.generic;
}

/** Shared styling for inline auth error boxes (role="alert"). */
const errorBoxClass =
  "text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm";

/**
 * "Forgot password" flow — requests a reset link. The server ALWAYS answers
 * 200 (never confirms whether the account exists), so the success state is a
 * generic reassurance card, never a claim about the account.
 */
function ForgotPasswordCard({ onBackToSignIn }: { onBackToSignIn: () => void }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestMutation = useMutation({
    mutationFn: async () =>
      api<{ message?: string }>("/api/v1/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    onSuccess: () => {
      setError(null);
      // Generic by design — never claim whether the account exists, and UI
      // copy is always locale-driven (server message is for API consumers).
      setSentMessage(t("resetSentGeneric"));
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.status === 0) setError(t("errors.network"));
        else if (err.code === "RESET_DELIVERY_UNAVAILABLE") setError(t("errors.resetUnavailable"));
        else if (err.code === "RATE_LIMITED") setError(t("errors.rateLimited"));
        else setError(t("errors.generic"));
      } else {
        setError(t("errors.generic"));
      }
    },
  });

  return (
    <Card className="w-full max-w-md shadow-sm">
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-2xl">{t("forgotTitle")}</CardTitle>
        <CardDescription>{t("forgotSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        {sentMessage ? (
          <div className="space-y-5 py-2 text-center">
            <div
              className="bg-primary/10 mx-auto flex size-12 items-center justify-center rounded-full"
              aria-hidden="true"
            >
              <MailCheck className="text-primary size-6" />
            </div>
            <div className="space-y-2">
              <p className="text-foreground text-sm" role="status">
                {sentMessage}
              </p>
              <p className="text-muted-foreground text-xs">{t("resetLinkExpiryNote")}</p>
            </div>
            <Button type="button" variant="outline" className="w-full" onClick={onBackToSignIn}>
              <LogIn className="size-4" aria-hidden="true" />
              {t("backToSignIn")}
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              requestMutation.mutate();
            }}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="forgot-email">{t("email")}</Label>
              <Input
                id="forgot-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                dir="ltr"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {error ? (
              <p className={errorBoxClass} role="alert">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={requestMutation.isPending}>
              {requestMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <MailCheck className="size-4" aria-hidden="true" />
              )}
              {t("sendResetLink")}
            </Button>

            <p className="text-center text-sm">
              <button
                type="button"
                className="text-primary font-medium underline-offset-4 hover:underline"
                onClick={onBackToSignIn}
              >
                {t("backToSignIn")}
              </button>
            </p>

            <div className="bg-muted/50 text-muted-foreground rounded-md px-3 py-2 text-xs">
              <ShieldCheck className="me-1.5 inline size-3.5" aria-hidden="true" />
              {t("privacyNote")}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * "Reset password" flow — consumes a single-use token from the deep link
 * (#/reset-password/<token>). On success every previous session is dead:
 * any stale local session is cleared immediately and the user is sent to
 * sign-in via the success card button.
 */
function ResetPasswordCard({
  token,
  onGoToSignIn,
  onRequestNewLink,
}: {
  token: string;
  onGoToSignIn: () => void;
  onRequestNewLink: () => void;
}) {
  const t = useTranslations("auth");
  const queryClient = useQueryClient();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const resetMutation = useMutation({
    mutationFn: async () =>
      api<{ message?: string }>("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token, newPassword, confirmPassword }),
      }),
    onSuccess: () => {
      setError(null);
      setTokenInvalid(false);
      setDoneMessage(t("resetSuccessBody"));
      // The server killed every session for this user — clear any stale
      // local one right away (the success card below routes to sign-in).
      void signOut({ redirect: false });
      void queryClient.invalidateQueries();
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.code === "INVALID_RESET_TOKEN") {
          setTokenInvalid(true);
          setError(null);
        } else if (err.status === 0) {
          setTokenInvalid(false);
          setError(t("errors.network"));
        } else if (err.code === "RATE_LIMITED") {
          setTokenInvalid(false);
          setError(t("errors.rateLimited"));
        } else {
          setTokenInvalid(false);
          setError(t("errors.generic"));
        }
      } else {
        setTokenInvalid(false);
        setError(t("errors.generic"));
      }
    },
  });

  return (
    <Card className="w-full max-w-md shadow-sm">
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-2xl">
          {doneMessage ? t("resetSuccessTitle") : t("resetTitle")}
        </CardTitle>
        {doneMessage ? null : <CardDescription>{t("resetSubtitle")}</CardDescription>}
      </CardHeader>
      <CardContent>
        {doneMessage ? (
          <div className="space-y-5 py-2 text-center">
            <div
              className="bg-primary/10 mx-auto flex size-12 items-center justify-center rounded-full"
              aria-hidden="true"
            >
              <KeyRound className="text-primary size-6" />
            </div>
            <p className="text-foreground text-sm" role="status">
              {doneMessage}
            </p>
            <Button type="button" className="w-full" onClick={onGoToSignIn}>
              <LogIn className="size-4" aria-hidden="true" />
              {t("goToSignIn")}
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setTokenInvalid(false);
              if (newPassword !== confirmPassword) {
                setError(t("errors.passwordMismatch"));
                return;
              }
              resetMutation.mutate();
            }}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="reset-password">{t("newPassword")}</Label>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                dir="ltr"
                placeholder={t("passwordPlaceholder")}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
              <p className="text-muted-foreground text-xs">{t("passwordHint")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reset-confirm">{t("confirmNewPassword")}</Label>
              <Input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                dir="ltr"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>

            {tokenInvalid ? (
              <div className={errorBoxClass} role="alert">
                <p>{t("errors.invalidResetToken")}</p>
                <button
                  type="button"
                  className="text-primary mt-1.5 font-medium underline-offset-4 hover:underline"
                  onClick={onRequestNewLink}
                >
                  {t("sendResetLink")}
                </button>
              </div>
            ) : error ? (
              <p className={errorBoxClass} role="alert">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={resetMutation.isPending}>
              {resetMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="size-4" aria-hidden="true" />
              )}
              {t("resetSubmit")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function AuthView() {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  // next-intl's t is a function — nested property access (t.errors) is
  // undefined at runtime, which crashed the onError handlers. Build the
  // message map with explicit t() calls instead (BUGFIX r8).
  const authErrorMessages: AuthErrors = {
    invalidCredentials: t("errors.invalidCredentials"),
    rateLimited: t("errors.rateLimited"),
    emailTaken: t("errors.emailTaken"),
    passwordMismatch: t("errors.passwordMismatch"),
    passwordPolicy: t("errors.passwordPolicy"),
    invalidData: t("errors.invalidData"),
    network: t("errors.network"),
    generic: t("errors.generic"),
  };
  const { status } = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Prompt 30 §46/§109 — the MFA login step machine. Password success with
  // MFA enabled NEVER creates a session (authorize throws the fixed
  // MFA_REQUIRED code); the client then obtains a SHORT-LIVED challenge,
  // collects the TOTP/recovery code, and exchanges it for a ONE-TIME
  // assertion that completes the real NextAuth login.
  const [mfaStage, setMfaStage] = useState<"idle" | "challenge" | "code">("idle");
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaMethod, setMfaMethod] = useState<"TOTP" | "RECOVERY_CODE">("TOTP");
  const [mfaCode, setMfaCode] = useState("");
  // Prompt 27 §53/§58: explicit legal acceptance — UNCHECKED by default, with
  // links to the actual documents BEFORE acceptance. Required by the signup UI.
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const tLegal = useTranslations("legal.auth");

  const signInMutation = useMutation({
    mutationFn: async () => {
      const res = await signIn("credentials", { redirect: false, email, password });
      if (!res || res.error) throw new Error(res?.error ?? "CredentialsSignin");
      return res;
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => {
      // Prompt 30 §110 — MFA_REQUIRED arrives ONLY after the password was
      // verified inside authorize(); switch to the bounded MFA step.
      if (err.message === "MFA_REQUIRED") {
        void startMfaChallenge();
        return;
      }
      setError(
        err instanceof ApiClientError
          ? mapApiError(err, authErrorMessages)
          : mapSignInError(err.message, authErrorMessages),
      );
    },
  });

  // Step 2 of the MFA flow (§46): re-verify the password at the dedicated
  // endpoint to obtain the challenge token (rate-limited, hash-only server
  // state, bound to the user's sessionVersion).
  const startMfaChallenge = () => {
    setMfaStage("challenge");
    mfaChallengeMutation.mutate();
  };

  const mfaChallengeMutation = useMutation({
    mutationFn: async () =>
      api<{ mfaRequired: boolean; challenge: string; expiresAt: string }>(
        "/api/v1/auth/mfa/challenge",
        { method: "POST", body: JSON.stringify({ email, password }), businessId: null },
      ),
    onSuccess: (res) => {
      setMfaChallenge(res.challenge);
      setMfaStage("code");
      setMfaCode("");
      setError(null);
    },
    onError: (err) => {
      setMfaStage("idle");
      if (err instanceof ApiClientError) {
        if (err.code === "MFA_NOT_ENABLED") {
          // The account has no MFA (state changed mid-flow) — retry plain.
          signInMutation.mutate();
          return;
        }
        if (err.code === "RATE_LIMITED") {
          setError(t("mfaRateLimited"));
          return;
        }
        if (err.code === "INVALID_CREDENTIALS") {
          setError(authErrorMessages.invalidCredentials);
          return;
        }
      }
      setError(authErrorMessages.generic);
    },
  });

  // Step 3 (§51): exchange challenge + code for the one-time assertion,
  // then complete the REAL NextAuth sign-in with it (§52 — the final JWT
  // is still issued by NextAuth only).
  const mfaCompleteMutation = useMutation({
    mutationFn: async () => {
      const assertion = await api<{ assertion: string }>("/api/v1/auth/mfa/complete", {
        method: "POST",
        body: JSON.stringify({ challenge: mfaChallenge, code: mfaCode, method: mfaMethod }),
        businessId: null,
      });
      const res = await signIn("credentials", {
        redirect: false,
        email,
        mfaAssertion: assertion.assertion,
      });
      if (!res || res.error) throw new Error(res?.error ?? "CredentialsSignin");
      return res;
    },
    onSuccess: () => {
      setMfaStage("idle");
      setMfaChallenge(null);
      setMfaCode("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.code === "MFA_INVALID_CODE") {
          setError(t("mfaInvalidCode"));
          setMfaCode("");
          return;
        }
        if (err.code === "MFA_CHALLENGE_EXPIRED" || err.code === "MFA_CHALLENGE_INVALID") {
          setError(t("mfaChallengeExpired"));
          return;
        }
        if (err.code === "MFA_RATE_LIMITED" || err.code === "RATE_LIMITED") {
          setError(t("mfaRateLimited"));
          return;
        }
        if (err.code === "MFA_RECOVERY_CODE_INVALID" || err.code === "MFA_RECOVERY_CODE_USED") {
          setError(t("mfaInvalidCode"));
          setMfaCode("");
          return;
        }
      }
      // Assertion replay/expiry inside authorize(): restart the MFA step.
      if (err.message === "MFA_REQUIRED") {
        setError(t("mfaChallengeExpired"));
        setMfaStage("idle");
        setMfaChallenge(null);
        return;
      }
      setError(authErrorMessages.generic);
    },
  });

  const registerMutation = useMutation({
    mutationFn: async () => {
      await api("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password,
          // Server resolves the accepted document versions (Prompt 27 §163).
          acceptedLegal: acceptedLegal ? { terms: true, privacy: true } : undefined,
        }),
      });
      const res = await signIn("credentials", { redirect: false, email, password });
      if (!res || res.error) throw new Error(res?.error ?? "CredentialsSignin");
      return res;
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries();
    },
    onError: (err) => {
      setError(
        err instanceof ApiClientError
          ? mapApiError(err, authErrorMessages)
          : mapSignInError(err.message, authErrorMessages),
      );
    },
  });

  const busy = signInMutation.isPending || registerMutation.isPending || status === "loading";

  // Store-driven mode switches (hash updates): password flows always route
  // through navigate() so deep links, back/forward and refresh all work.
  function goBackToSignIn() {
    setMode("signin");
    setError(null);
    navigate({ kind: "dashboard" });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "signup") {
      if (password !== confirmPassword) {
        setError(t("errors.passwordMismatch"));
        return;
      }
      // Client-side mirror of the server password policy (auth-security
      // passwordSchema): min 8 chars, at least one letter and one digit.
      // Without this the server 422 was surfaced as a useless generic error.
      if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        setError(t("errors.passwordPolicy"));
        return;
      }
      if (!acceptedLegal) {
        // Honest gate: the product requires explicit acceptance before an
        // account is created (Prompt 27 §53) — the API records the versions.
        setError(tLegal("acceptRequired"));
        return;
      }
      registerMutation.mutate();
    } else {
      signInMutation.mutate();
    }
  }

  return (
    <div className="bg-muted/30 flex min-h-svh flex-col lg:flex-row" data-view="auth">
      {/* Brand panel */}
      <div className="from-primary/5 via-primary/10 to-primary/5 relative flex flex-1 flex-col justify-between overflow-hidden p-8 lg:p-14">
        <div
          className="bg-primary/5 pointer-events-none absolute -top-24 -end-24 size-72 rounded-full blur-3xl"
          aria-hidden="true"
        />
        <div
          className="bg-primary/5 pointer-events-none absolute -bottom-24 -start-24 size-72 rounded-full blur-3xl"
          aria-hidden="true"
        />
        <div className="flex items-center gap-3">
          <div className="bg-background shadow-sm flex size-11 items-center justify-center rounded-xl border">
            <img src="/logo.svg" alt="" className="size-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-lg font-semibold tracking-tight gradient-text">
              {tCommon("appName")}
            </p>
            <p className="text-muted-foreground text-xs">{tCommon("tagline")}</p>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-md space-y-8 py-12">
          <div className="space-y-3">
            <h2 className="text-3xl font-semibold tracking-tight gradient-text gradient-shimmer lg:text-4xl">
              {tCommon("tagline")}
            </h2>
            <p className="text-muted-foreground text-base">
              {tCommon("marketing.sub")}
            </p>
          </div>
          <ul className="space-y-4">
            {[
              { icon: ShieldCheck, text: tCommon("marketing.point1") },
              { icon: TrendingUp, text: tCommon("marketing.point2") },
              { icon: Sparkles, text: tCommon("marketing.point3") },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="bg-background text-primary flex size-9 shrink-0 items-center justify-center rounded-lg border shadow-sm">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="text-muted-foreground text-sm">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Form panel — password flows (forgot/reset) swap the card; the
          sign-in/sign-up card is unchanged apart from the reset link. */}
      <div className="flex flex-1 items-center justify-center p-6 lg:p-10">
        {view.kind === "forgot-password" ? (
          <ForgotPasswordCard onBackToSignIn={goBackToSignIn} />
        ) : view.kind === "reset-password" ? (
          <ResetPasswordCard
            token={view.token}
            onGoToSignIn={goBackToSignIn}
            onRequestNewLink={() => {
              setError(null);
              navigate({ kind: "forgot-password" });
            }}
          />
        ) : mfaStage === "code" ? (
          <MfaLoginCard
            error={error}
            method={mfaMethod}
            setMethod={setMfaMethod}
            code={mfaCode}
            setCode={setMfaCode}
            busy={mfaCompleteMutation.isPending}
            onSubmit={() => mfaCompleteMutation.mutate()}
            onRestart={() => {
              setMfaStage("idle");
              setMfaChallenge(null);
              setMfaCode("");
              setError(null);
            }}
          />
        ) : (
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="space-y-1.5">
            <CardTitle className="text-2xl">
              {mode === "signin" ? t("signInTitle") : t("signUpTitle")}
            </CardTitle>
            <CardDescription>
              {mode === "signin" ? t("signInSubtitle") : t("signUpSubtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              {mode === "signup" ? (
                <div className="space-y-2">
                  <Label htmlFor="name">{t("name")}</Label>
                  <Input
                    id="name"
                    autoComplete="name"
                    placeholder={t("namePlaceholder")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="email">{t("email")}</Label>
                <Input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  dir="ltr"
                  placeholder={t("emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t("password")}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  dir="ltr"
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "signup" ? 8 : undefined}
                />
                {mode === "signup" ? (
                  <p className="text-muted-foreground text-xs">{t("passwordHint")}</p>
                ) : null}
              </div>

              {mode === "signin" ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-primary text-sm underline-offset-4 hover:underline"
                    onClick={() => {
                      setError(null);
                      navigate({ kind: "forgot-password" });
                    }}
                  >
                    {t("forgotPassword")}
                  </button>
                </div>
              ) : null}

              {mode === "signup" ? (
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">{t("confirmPassword")}</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    dir="ltr"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
              ) : null}

              {mode === "signup" ? (
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="acceptLegal"
                    checked={acceptedLegal}
                    onCheckedChange={(v) => setAcceptedLegal(v === true)}
                    className="mt-0.5"
                    required
                  />
                  <Label
                    htmlFor="acceptLegal"
                    className="text-muted-foreground text-start text-xs leading-5 font-normal"
                  >
                    {tLegal("acceptPrefix")}{" "}
                    <a
                      href="/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {tLegal("acceptTerms")}
                    </a>{" "}
                    {tLegal("acceptAnd")}{" "}
                    <a
                      href="/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {tLegal("acceptPrivacy")}
                    </a>
                  </Label>
                </div>
              ) : null}

              {error ? (
                <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert">
                  {error}
                </p>
              ) : null}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : mode === "signin" ? (
                  <LogIn className="size-4" aria-hidden="true" />
                ) : (
                  <UserPlus className="size-4" aria-hidden="true" />
                )}
                {mode === "signin"
                  ? busy
                    ? t("signingIn")
                    : t("signIn")
                  : busy
                    ? t("creatingAccount")
                    : t("signUp")}
              </Button>

              <p className="text-center text-sm">
                {mode === "signin" ? t("noAccount") : t("haveAccount")}{" "}
                <button
                  type="button"
                  className="text-primary font-medium underline-offset-4 hover:underline"
                  onClick={() => {
                    setMode(mode === "signin" ? "signup" : "signin");
                    setError(null);
                  }}
                >
                  {mode === "signin" ? t("signUp") : t("signIn")}
                </button>
              </p>

              <div className="bg-muted/50 text-muted-foreground rounded-md px-3 py-2 text-xs">
                <ShieldCheck className="me-1.5 inline size-3.5" aria-hidden="true" />
                {t("privacyNote")}
              </div>

              {/* Legal links (Prompt 27 §60/§149) — real public documents,
                  localized labels, new tab so form state survives. */}
              <p className="text-muted-foreground text-center text-xs">
                {tLegal("legalLinksLabel")}:{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground underline-offset-4 hover:underline"
                >
                  {tLegal("acceptPrivacy")}
                </a>
                {" · "}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground underline-offset-4 hover:underline"
                >
                  {tLegal("acceptTerms")}
                </a>
                {" · "}
                <a
                  href="/ai-data-use"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground underline-offset-4 hover:underline"
                >
                  {tLegal("aiDataUseLink")}
                </a>
              </p>
            </form>
          </CardContent>
        </Card>
        )}
      </div>
    </div>
  );
}

/* ------------------------- MFA login card (§110-§111) ---------------------- */

/**
 * Second-factor step — rendered ONLY after the password was verified inside
 * authorize() (the MFA_REQUIRED code never leaks account state before that,
 * §280). Generic error copy (§111); OTP input accepts digits + paste
 * (§101); proper labels beyond placeholders (§102); the code is never
 * placed in any URL (§101).
 */
function MfaLoginCard({
  error,
  method,
  setMethod,
  code,
  setCode,
  busy,
  onSubmit,
  onRestart,
}: {
  error: string | null;
  method: "TOTP" | "RECOVERY_CODE";
  setMethod: (m: "TOTP" | "RECOVERY_CODE") => void;
  code: string;
  setCode: (c: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onRestart: () => void;
}) {
  const t = useTranslations("auth");

  return (
    <Card className="w-full max-w-md shadow-sm">
      <CardHeader className="space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-2xl">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
          {t("mfaTitle")}
        </CardTitle>
        <CardDescription>{t("mfaSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) onSubmit();
          }}
          className="space-y-4"
          noValidate
        >
          {method === "TOTP" ? (
            <div className="space-y-2">
              <Label htmlFor="mfa-otp">{t("mfaCodeLabel")}</Label>
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                containerClassName="justify-start"
              >
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
          ) : (
            <div className="space-y-2">
              <Label htmlFor="mfa-recovery">{t("mfaRecoveryLabel")}</Label>
              <Input
                id="mfa-recovery"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("mfaRecoveryPlaceholder")}
                autoComplete="off"
                className="font-mono"
                dir="ltr"
                maxLength={64}
              />
            </div>
          )}
          {error ? (
            <p className={errorBoxClass} role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy || code.length === 0}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="h-4 w-4" aria-hidden="true" />
            )}
            {t("mfaVerify")}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setMethod(method === "TOTP" ? "RECOVERY_CODE" : "TOTP");
                setCode("");
              }}
            >
              {method === "TOTP" ? t("mfaUseRecovery") : t("mfaUseAuthenticator")}
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              onClick={onRestart}
            >
              {t("mfaRestart")}
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type AuthErrors = {
  invalidCredentials: string;
  rateLimited: string;
  emailTaken: string;
  passwordMismatch: string;
  network: string;
  generic: string;
};

function mapSignInError(error: string | null | undefined, t: AuthErrors): string {
  if (error === "CredentialsSignin") return t.invalidCredentials;
  return t.generic;
}

function mapApiError(err: unknown, t: AuthErrors): string {
  if (err instanceof ApiClientError) {
    if (err.status === 0) return t.network;
    if (err.code === "EMAIL_TAKEN") return t.emailTaken;
    if (err.code === "RATE_LIMITED") return t.rateLimited;
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
      setError(
        err instanceof ApiClientError
          ? mapApiError(err, authErrorMessages)
          : mapSignInError(err.message, authErrorMessages),
      );
    },
  });

  const registerMutation = useMutation({
    mutationFn: async () => {
      await api("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
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

        <p className="text-muted-foreground/70 relative text-xs">
          {tCommon("marketing.localesNote")}
        </p>
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
            </form>
          </CardContent>
        </Card>
        )}
      </div>
    </div>
  );
}

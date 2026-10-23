"use client";

import { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  Mail,
  MailCheck,
  ShieldCheck,
  Sparkles,
  User,
  UserPlus,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from "@/components/ui/input-otp";
import { LocaleSwitcher, ThemeToggle } from "@/modules/shell/header";
import { BusinessWebGLBackground } from "@/components/fx/business-webgl-bg";

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

/* ─────────────── Modern auth presentation helpers (r52) ───────────────
   Glass card + hairline + icon badge + leading field icons + password
   visibility toggles. Presentation ONLY — zero auth logic changes. */

/** Glassmorphism card surface shared by every auth card. */
const glassCardClass =
  "relative w-full overflow-hidden border-border/60 bg-background/75 shadow-xl shadow-black/5 backdrop-blur-xl dark:bg-card/60 dark:shadow-black/30";

/** Top hairline accent — a subtle brand gradient across the card top. */
function CardTopHairline() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
    />
  );
}

/** Icon badge above the card title (modern auth-card signature). */
function AuthCardBadge({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="bg-primary/10 text-primary border-primary/20 mb-2 flex size-11 items-center justify-center rounded-xl border"
    >
      {children}
    </div>
  );
}

/** Leading icon inside a form field (absolute, RTL-aware via start-*). */
function FieldIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      aria-hidden="true"
      className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
    />
  );
}

/** Password show/hide toggle — 44px hit area, aria-pressed + label. */
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

/** Entrance motion helper — honors prefers-reduced-motion (no animation). */
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];
function useEnterMotion() {
  const reduceMotion = useReducedMotion();
  return (delay = 0) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.5, delay, ease: EASE_OUT },
        };
}

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
    <Card className={glassCardClass}>
      <CardTopHairline />
      <CardHeader className="space-y-1.5">
        <AuthCardBadge>
          <MailCheck className="size-5" />
        </AuthCardBadge>
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
              <div className="relative">
                <FieldIcon icon={Mail} />
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
                  className="h-11 ps-9"
                />
              </div>
            </div>

            {error ? (
              <p className={errorBoxClass} role="alert">
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              className="h-11 w-full bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-600/25 transition-all hover:from-emerald-500 hover:to-teal-500 hover:shadow-emerald-600/40 dark:from-emerald-500 dark:to-teal-500 dark:hover:from-emerald-400 dark:hover:to-teal-400"
              disabled={requestMutation.isPending}
            >
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
  // Password visibility toggles (presentation only — never affects logic).
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const pwLabels = { show: t("showPassword"), hide: t("hidePassword") };

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
    <Card className={glassCardClass}>
      <CardTopHairline />
      <CardHeader className="space-y-1.5">
        <AuthCardBadge>
          <KeyRound className="size-5" />
        </AuthCardBadge>
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
              <div className="relative">
                <FieldIcon icon={Lock} />
                <Input
                  id="reset-password"
                  type={showNew ? "text" : "password"}
                  autoComplete="new-password"
                  dir="ltr"
                  placeholder={t("passwordPlaceholder")}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className="h-11 ps-9 pe-10"
                />
                <PasswordVisibilityButton
                  show={showNew}
                  onClick={() => setShowNew((v) => !v)}
                  labels={pwLabels}
                />
              </div>
              <p className="text-muted-foreground text-xs">{t("passwordHint")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reset-confirm">{t("confirmNewPassword")}</Label>
              <div className="relative">
                <FieldIcon icon={Lock} />
                <Input
                  id="reset-confirm"
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  dir="ltr"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="h-11 ps-9 pe-10"
                />
                <PasswordVisibilityButton
                  show={showConfirm}
                  onClick={() => setShowConfirm((v) => !v)}
                  labels={pwLabels}
                />
              </div>
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

            <Button
              type="submit"
              className="h-11 w-full bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-600/25 transition-all hover:from-emerald-500 hover:to-teal-500 hover:shadow-emerald-600/40 dark:from-emerald-500 dark:to-teal-500 dark:hover:from-emerald-400 dark:hover:to-teal-400"
              disabled={resetMutation.isPending}
            >
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

/**
 * R65 — presentation-only platform variant: when the platform console renders
 * the sign-in (unauthenticated visitor to #/platform), the SAME form carries
 * platform branding (title/subtitle from the platform namespace) plus one
 * security-note line. Zero auth-logic changes — the default variant is
 * byte-identical to the previous behavior.
 */
export function AuthView({ variant = "default" }: { variant?: "default" | "platform" }) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const tPlatform = useTranslations("platform");
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
  // Password visibility toggles (presentation only — never affects logic).
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const pwLabels = { show: t("showPassword"), hide: t("hidePassword") };
  const tLegal = useTranslations("legal.auth");
  const enter = useEnterMotion();

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
    <div className="relative flex min-h-svh flex-col" data-view="auth">
      {/* Layer −z-20: CSS gradient fallback — also the base the WebGL canvas
          composites on top of (and the only background when WebGL is
          unavailable). */}
      <div
        aria-hidden="true"
        className="bg-muted/30 from-primary/5 via-primary/10 to-primary/5 pointer-events-none fixed inset-0 -z-20 bg-gradient-to-br"
      />
      {/* Layer −z-10: business WebGL "growth field" (decorative, aria-hidden,
          pauses off-tab, static under prefers-reduced-motion). */}
      <BusinessWebGLBackground />

      {/* Locale + theme switches (icon-only) — the auth page previously had
          no way to switch language/theme at all; icon-only buttons keep it
          capability-complete without re-adding the removed text line. */}
      <div className="bg-background/60 absolute end-3 top-3 z-20 flex items-center gap-0.5 rounded-full border p-1 backdrop-blur-md sm:end-4 sm:top-4">
        <LocaleSwitcher />
        <ThemeToggle />
      </div>

      {/* Centered frame — on large devices the WHOLE composition (brand +
          form) lives inside one contained, centered glass frame so nothing
          hugs the viewport edges on wide screens (user report: on large
          displays the split layout spread to the edges with a huge empty
          middle). On mobile the frame chrome is disabled and the card
          centers exactly as before. */}
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col lg:px-8 lg:py-10">
        <div className="relative my-auto flex w-full flex-col lg:flex-row lg:overflow-hidden lg:rounded-3xl lg:border lg:border-border/60 lg:bg-background/60 lg:shadow-2xl lg:shadow-black/5 lg:backdrop-blur-xl dark:lg:border-border/40 dark:lg:bg-card/45 dark:lg:shadow-black/25">
      {/* Brand panel — marketing is vertically CENTERED between the logo
          header and the footer on desktop (fixes the old bottom-stuck
          "empty middle" imbalance) and hidden on mobile so the form is
          immediately reachable instead of pushed below the fold. */}
      <aside className="relative flex flex-col p-6 sm:p-8 lg:w-[46%] lg:flex-none lg:p-12">
        <div className="flex items-center gap-3">
          <div className="bg-background/80 shadow-sm flex size-11 items-center justify-center rounded-xl border backdrop-blur">
            <img src="/logo.svg" alt="" className="size-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-lg font-semibold tracking-tight gradient-text">
              {tCommon("appName")}
            </p>
            <p className="text-muted-foreground text-xs">{tCommon("tagline")}</p>
          </div>
        </div>

        <motion.div
          {...enter(0.05)}
          className="relative my-auto hidden w-full py-10 lg:block"
        >
          <div className="space-y-7">
            <div className="space-y-4">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles className="size-3.5" aria-hidden="true" />
                {tCommon("marketing.badge")}
              </span>
              <h2 className="text-3xl font-semibold tracking-tight gradient-text gradient-shimmer lg:text-4xl">
                {tCommon("tagline")}
              </h2>
              <p className="text-muted-foreground text-base leading-relaxed">
                {tCommon("marketing.sub")}
              </p>
            </div>
            <ul className="space-y-3">
              {[
                { icon: ShieldCheck, text: tCommon("marketing.point1") },
                { icon: TrendingUp, text: tCommon("marketing.point2") },
                { icon: Sparkles, text: tCommon("marketing.point3") },
              ].map(({ icon: Icon, text }) => (
                <li
                  key={text}
                  className="group flex items-center gap-3.5 rounded-xl border border-border/50 bg-background/40 p-3.5 backdrop-blur-sm transition-colors duration-200 hover:border-primary/40 hover:bg-primary/5"
                >
                  <span className="bg-primary/10 text-primary border-primary/20 flex size-10 shrink-0 items-center justify-center rounded-lg border transition-transform duration-200 group-hover:scale-105">
                    <Icon className="size-[18px]" aria-hidden="true" />
                  </span>
                  <span className="text-muted-foreground text-sm leading-relaxed">{text}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground/80 flex items-center gap-2 text-xs">
              <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
              {tCommon("marketing.trustLine")}
            </p>
          </div>
        </motion.div>

        <p className="text-muted-foreground/70 relative hidden text-xs lg:block">
          © {new Date().getFullYear()} {tCommon("appName")}
        </p>
      </aside>

      {/* Vertical gradient hairline separating the two frame columns
          (row flow only — hidden while stacked on mobile). */}
      <div
        aria-hidden="true"
        className="via-border/70 dark:via-border/40 hidden w-px self-stretch bg-gradient-to-b from-transparent to-transparent lg:block"
      />

      {/* Form panel — `m-auto` centering (NOT items-center): when the card
          is taller than the viewport (e.g. signup on small phones) the auto
          margins collapse to 0 and the page scrolls naturally instead of
          clipping the top of the card. */}
      <main className="relative flex flex-1 p-4 pb-8 sm:p-6 lg:p-10">
        <motion.div {...enter(0)} className="m-auto flex w-full max-w-md">
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
        <Card className={glassCardClass}>
          <CardTopHairline />
          <CardHeader className="space-y-1.5">
            {variant === "platform" ? (
              <>
                {/* R65 — platform branding header (reuses platform.* copy). */}
                <div className="border-emerald-500/30 bg-emerald-500/15 flex items-center gap-2.5 rounded-md border px-3 py-2">
                  <ShieldCheck className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                  <span className="grid leading-tight">
                    <span className="text-sm font-semibold">{tPlatform("title")}</span>
                    <span className="text-muted-foreground text-xs">{tPlatform("subtitle")}</span>
                  </span>
                </div>
              </>
            ) : null}
            <AuthCardBadge>
              {mode === "signin" ? <LogIn className="size-5" /> : <UserPlus className="size-5" />}
            </AuthCardBadge>
            <CardTitle className="text-2xl">
              {mode === "signin" ? t("signInTitle") : t("signUpTitle")}
            </CardTitle>
            <CardDescription>
              {mode === "signin" ? t("signInSubtitle") : t("signUpSubtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {variant === "platform" ? (
              <p className="text-muted-foreground border-border/60 mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <ShieldCheck className="me-1.5 inline size-3.5" aria-hidden="true" />
                {tPlatform("authNote")}
              </p>
            ) : null}
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              {mode === "signup" ? (
                <div className="space-y-2">
                  <Label htmlFor="name">{t("name")}</Label>
                  <div className="relative">
                    <FieldIcon icon={User} />
                    <Input
                      id="name"
                      autoComplete="name"
                      placeholder={t("namePlaceholder")}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={80}
                      className="h-11 ps-9"
                    />
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="email">{t("email")}</Label>
                <div className="relative">
                  <FieldIcon icon={Mail} />
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
                    className="h-11 ps-9"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t("password")}</Label>
                <div className="relative">
                  <FieldIcon icon={Lock} />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    dir="ltr"
                    placeholder={t("passwordPlaceholder")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={mode === "signup" ? 8 : undefined}
                    className="h-11 ps-9 pe-10"
                  />
                  <PasswordVisibilityButton
                    show={showPassword}
                    onClick={() => setShowPassword((v) => !v)}
                    labels={pwLabels}
                  />
                </div>
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
                  <div className="relative">
                    <FieldIcon icon={Lock} />
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      autoComplete="new-password"
                      dir="ltr"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      className="h-11 ps-9 pe-10"
                    />
                    <PasswordVisibilityButton
                      show={showConfirmPassword}
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      labels={pwLabels}
                    />
                  </div>
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

              <Button
                type="submit"
                className="h-11 w-full bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-600/25 transition-all hover:from-emerald-500 hover:to-teal-500 hover:shadow-emerald-600/40 dark:from-emerald-500 dark:to-teal-500 dark:hover:from-emerald-400 dark:hover:to-teal-400"
                disabled={busy}
              >
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
        </motion.div>
      </main>
        </div>
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
    <Card className={glassCardClass}>
      <CardTopHairline />
      <CardHeader className="space-y-1.5">
        <AuthCardBadge>
          <ShieldCheck className="size-5" />
        </AuthCardBadge>
        <CardTitle className="text-2xl">{t("mfaTitle")}</CardTitle>
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
                className="h-11 font-mono"
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
          <Button
            type="submit"
            className="h-11 w-full bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-600/25 transition-all hover:from-emerald-500 hover:to-teal-500 hover:shadow-emerald-600/40 dark:from-emerald-500 dark:to-teal-500 dark:hover:from-emerald-400 dark:hover:to-teal-400"
            disabled={busy || code.length === 0}
          >
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

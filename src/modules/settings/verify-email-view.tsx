"use client";

/**
 * Verify-email landing — Prompt 30 §250-§252, §249.
 *
 * Renders at #/verify-email/<token>. The token arrives ONLY from the email
 * link; it is submitted ONCE to the anonymous confirm endpoint and then
 * REMOVED from the visible URL (§252 — never kept in browser history
 * longer than necessary). The token is never placed in document.title,
 * analytics, error logs, or the clipboard (§251).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { CheckCircle2, CircleAlert, Loader2, MailCheck } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ConfirmResult = {
  verified: boolean;
  alreadyVerified: boolean;
};

export function VerifyEmailView({ token }: { token: string }) {
  const t = useTranslations("security");
  // §251 — submit ONCE; loading state is the mutation itself (no
  // setState-in-effect). The initial state is "loading" because the effect
  // below fires the confirm immediately on mount.
  const [state, setState] = useState<"idle" | "loading" | "ok" | "already" | "invalid">("loading");
  // §251 — submit once, even under React StrictMode double-mount.
  const firedRef = useRef(false);

  const confirm = useMutation({
    mutationFn: async () =>
      api<ConfirmResult>("/api/v1/auth/email-verification/confirm", {
        method: "POST",
        body: JSON.stringify({ token }),
        businessId: null,
      }),
    onSuccess: (res) => {
      setState(res.verified ? "ok" : res.alreadyVerified ? "already" : "invalid");
      // §252 — clean the token out of the visible URL after the outcome.
      try {
        window.history.replaceState(null, "", window.location.pathname + "#/settings/security");
      } catch {
        // history unavailable — outcome still shown
      }
    },
    onError: () => setState("invalid"),
  });

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    confirm.mutate();
  }, []);

  const title =
    state === "ok"
      ? t("emailVerified")
      : state === "already"
        ? t("emailAlreadyVerified")
        : state === "invalid"
          ? t("errors.generic")
          : t("emailVerifyAction");

  return (
    <main className="bg-background flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            {state === "loading" ? (
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" aria-hidden />
            ) : state === "invalid" ? (
              <CircleAlert className="h-10 w-10 text-destructive" aria-hidden />
            ) : (
              <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" aria-hidden />
            )}
          </div>
          <CardTitle className="flex items-center justify-center gap-2">
            <MailCheck className="h-4 w-4 text-primary" aria-hidden />
            {t("emailSection")}
          </CardTitle>
          <CardDescription>{title}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {state === "invalid" ? (
            <p className="text-center text-sm text-muted-foreground">
              {t("emailResendFailed")}
            </p>
          ) : null}
          <Button asChild>
            <Link href="#/settings/security">{t("mfaRecoveryDone")}</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

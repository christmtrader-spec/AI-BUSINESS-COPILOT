"use client";

/**
 * Platform console root — Prompt 28 (§15/§16/§17).
 *
 * Gate order: session → capability probe → console. A tenant navigating
 * directly to #/platform/* sees the honest "no platform access" state —
 * never a crash, never a partial render of platform data.
 *
 * R65 (§6.2 fail-closed): an operator whose account lacks the mandatory MFA
 * gets the dedicated MFA gate (amber policy notice + enrollment path) — a
 * distinct state from a tenant's plain 403. Unauthenticated visitors get the
 * platform-branded sign-in (variant="platform", presentation only).
 *
 * R68 (cold-start fix): a tenant's plain 403 is NO LONGER a dead end. While
 * the platform has ZERO operators, the probe's null is upgraded to the
 * setup gate — an authenticated session can redeem a single-use offline-
 * minted setup key and become the first PLATFORM_SUPER_ADMIN (server-side
 * window check; self-disables forever after the first claim). Once operators
 * exist, the honest "no platform access" card returns — now with truthful
 * guidance pointing at the R67 invite flow instead of a bare refusal.
 */
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { ShieldOff, ArrowUpRight, Link2, TerminalSquare, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { Splash } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AuthView } from "@/modules/auth/auth-view";
import { usePlatformSelf } from "./use-platform-self";
import { PlatformShell } from "./platform-shell";
import { MfaGateScreen } from "./mfa-gate";
import { PlatformSetupGate } from "./setup-gate";
import { platformApi } from "./platform-api";

type SetupStatus = { setupRequired: boolean };

export function PlatformRoot() {
  const { status } = useSession();
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);
  const view = useAppStore((s) => s.view);
  const section = view.kind === "platform" ? view.section : "overview";

  const probe = usePlatformSelf(status === "authenticated");

  // R68 — the zero-operator window probe runs ONLY for a plain-tenant 403
  // (probe.data === null): operators and MFA-gated users never see it, and
  // the extra call costs nothing for the session-lifetime cache.
  const setupStatus = useQuery({
    queryKey: ["platform", "setup", "status"],
    queryFn: () => platformApi<SetupStatus>("/api/v1/platform/setup"),
    enabled: status === "authenticated" && probe.data === null,
    staleTime: 15_000,
    retry: false,
  });

  if (status === "loading" || (status === "authenticated" && probe.isLoading)) {
    return <Splash label={t("loading")} />;
  }
  if (status !== "authenticated") {
    return <AuthView variant="platform" />;
  }
  // R65 §6.2 — the operator exists but the zero-trust MFA policy blocks the
  // console. Amber gate + honest enrollment; never a partial console render.
  if (probe.data === "mfa-required") {
    return <MfaGateScreen />;
  }
  if (probe.data == null) {
    // R68 — cold-start window: let an authenticated session claim the first
    // super admin with an offline-minted setup key (server-verified).
    if (setupStatus.isLoading) {
      return (
        <main className="bg-background flex min-h-svh items-center justify-center px-4">
          <div className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t("loading")}
          </div>
        </main>
      );
    }
    if (setupStatus.data?.setupRequired) {
      return <PlatformSetupGate />;
    }
    return (
      <main className="bg-background flex min-h-svh items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/15">
              <ShieldOff className="size-5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            </div>
            <CardTitle>{t("noAccessTitle")}</CardTitle>
            <CardDescription>{t("noAccessBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* R68 — the refusal now tells the truth about HOW access is
              granted (invite flow), instead of a bare dead end. */}
            <div className="border-border/60 rounded-lg border border-dashed p-4">
              <ul className="text-muted-foreground space-y-2 text-xs leading-relaxed">
                <li className="flex items-start gap-2">
                  <Link2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{t("noAccessHowInvite")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <TerminalSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{t("noAccessHowOwner")}</span>
                </li>
              </ul>
            </div>
            <Button variant="outline" onClick={() => navigate({ kind: "dashboard" })}>
              <ArrowUpRight className="size-4" aria-hidden="true" />
              {t("backToWorkspace")}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return <PlatformShell self={probe.data} section={section} />;
}

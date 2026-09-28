"use client";

/**
 * Platform console root — Prompt 28 (§15/§16/§17).
 *
 * Gate order: session → capability probe → console. A tenant navigating
 * directly to #/platform/* sees the honest "no platform access" state —
 * never a crash, never a partial render of platform data.
 */
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { ShieldOff, ArrowUpRight } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { Splash } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AuthView } from "@/modules/auth/auth-view";
import { usePlatformSelf } from "./use-platform-self";
import { PlatformShell } from "./platform-shell";

export function PlatformRoot() {
  const { status } = useSession();
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);
  const view = useAppStore((s) => s.view);
  const section = view.kind === "platform" ? view.section : "overview";

  const probe = usePlatformSelf(status === "authenticated");

  if (status === "loading" || (status === "authenticated" && probe.isLoading)) {
    return <Splash label={t("loading")} />;
  }
  if (status !== "authenticated") {
    return <AuthView />;
  }
  if (probe.data == null) {
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
          <CardContent>
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

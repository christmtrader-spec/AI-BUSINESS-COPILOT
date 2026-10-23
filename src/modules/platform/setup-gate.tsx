"use client";

/**
 * Platform setup gate — R68 (cold-start fix for the first operator).
 *
 * Rendered by PlatformRoot INSTEAD of the old dead-end "no platform access"
 * card WHILE the platform is in the zero-operator setup window (server-side
 * truth, probed live). The platform owner mints a single-use setup key with
 * the OFFLINE CLI (scripts/platform-setup-key.ts) and an authenticated
 * session redeems it here to become the first PLATFORM_SUPER_ADMIN.
 *
 * Laws mirrored from the server (§9/§60/§86/§137):
 *  - Honest state machine: the key is treated like a password (masked input,
 *    show/hide toggle) — it is displayed-once by the CLI and never logged.
 *  - Every server failure maps to a fixed, localized, safe message — no raw
 *    network text, no stack traces, no difference between "wrong key" and
 *    "malformed key" beyond the server's own code.
 *  - On success the capability probe is invalidated: the root re-probes
 *    /platform/self, sees the new operator WITHOUT MFA, and fail-closes into
 *    the R65 MFA enrollment gate — this screen never pretends to grant
 *    console data itself.
 *  - Semantic warning tone (amber) is preserved for the "window" notice;
 *    the action surface uses the R67 platform brand gradient.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  KeyRound,
  Eye,
  EyeOff,
  ShieldCheck,
  ShieldOff,
  ArrowUpRight,
  Loader2,
  Link2,
  TerminalSquare,
  LockKeyhole,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { platformApi } from "./platform-api";
import {
  PLATFORM_BRAND_BADGE,
  PLATFORM_GRADIENT_CTA,
} from "./kit";

type SetupStatus = { setupRequired: boolean };

/** Localized, safe mapping of the server's fixed error codes (§86/§137). */
const SETUP_ERROR_KEYS: Record<string, string> = {
  SETUP_KEY_INVALID: "errInvalid",
  SETUP_KEY_USED: "errUsed",
  SETUP_KEY_EXPIRED: "errExpired",
  SETUP_KEY_BOUND_MISMATCH: "errBound",
  SETUP_UNAVAILABLE: "errUnavailable",
  RATE_LIMITED: "errRate",
  PLATFORM_UNAUTHENTICATED: "errUnauthenticated",
};

export function PlatformSetupGate() {
  const t = useTranslations("platform.setupGate");
  const tRoot = useTranslations("platform");
  const queryClient = useQueryClient();
  const navigate = useAppStore((s) => s.navigate);
  const [key, setKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // Live server truth — the window can close at any moment (first claim).
  const status = useQuery({
    queryKey: ["platform", "setup", "status"],
    queryFn: () => platformApi<SetupStatus>("/api/v1/platform/setup"),
    staleTime: 15_000,
    retry: false,
  });

  async function activate() {
    const trimmed = key.trim();
    if (trimmed.length < 32 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await platformApi<{ activated: boolean; next: string }>("/api/v1/platform/setup", {
        method: "POST",
        body: JSON.stringify({ key: trimmed }),
      });
      // Fail-closed handoff: the root re-probes /self — the new super admin
      // without MFA lands in the R65 enrollment gate, never a raw console.
      await queryClient.invalidateQueries({ queryKey: ["platform", "self"] });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        const mapped = SETUP_ERROR_KEYS[err.code];
        setError(mapped ? t(mapped as Parameters<typeof t>[0]) : err.message || t("errGeneric"));
      } else {
        setError(t("errGeneric"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="bg-background flex min-h-svh items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15">
              <ShieldCheck className="size-5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            </div>
            <CardTitle>{t("successTitle")}</CardTitle>
            <CardDescription>{t("successBody")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {tRoot("loading")}
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (status.isLoading) {
    return (
      <main className="bg-background flex min-h-svh items-center justify-center px-4">
        <div className="text-muted-foreground flex items-center gap-2 text-sm" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("checking")}
        </div>
      </main>
    );
  }

  // The window closed (first operator exists) — the honest dead-end card.
  if (status.data && !status.data.setupRequired) {
    return (
      <main className="bg-background flex min-h-svh items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/15">
              <ShieldOff className="size-5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            </div>
            <CardTitle>{tRoot("noAccessTitle")}</CardTitle>
            <CardDescription>{tRoot("noAccessBody")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate({ kind: "dashboard" })}>
              <ArrowUpRight className="size-4" aria-hidden="true" />
              {tRoot("backToWorkspace")}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (status.isError) {
    // Session-level failures surface the platform root's own states; a plain
    // network hiccup shows a safe retry message (§86 — no raw network text).
    return (
      <main className="bg-background flex min-h-svh items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t("checkingTitle")}</CardTitle>
            <CardDescription>{t("errGeneric")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => status.refetch()}>
              {t("retry")}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="bg-background flex min-h-svh items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div
              className={`flex size-10 shrink-0 items-center justify-center rounded-full border ${PLATFORM_BRAND_BADGE}`}
              aria-hidden="true"
            >
              <KeyRound className="size-5" />
            </div>
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400 whitespace-nowrap">
              {t("windowOpenBadge")}
            </Badge>
          </div>
          <CardTitle className="pt-2">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="platform-setup-key">{t("keyLabel")}</Label>
            <div className="relative">
              <Input
                id="platform-setup-key"
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void activate();
                }}
                placeholder={t("keyPlaceholder")}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                className="font-mono pe-10"
                aria-describedby="platform-setup-key-hint"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="text-muted-foreground hover:text-foreground absolute inset-y-0 end-0 flex w-10 items-center justify-center"
                aria-label={showKey ? t("hideKey") : t("showKey")}
              >
                {showKey ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p id="platform-setup-key-hint" className="text-muted-foreground text-xs">
              {t("keyHint")}
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <Button
            className={`w-full ${PLATFORM_GRADIENT_CTA}`}
            onClick={() => void activate()}
            disabled={submitting || key.trim().length < 32}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("activating")}
              </>
            ) : (
              <>
                <ShieldCheck className="size-4" aria-hidden="true" />
                {t("activate")}
              </>
            )}
          </Button>

          <div className="border-border/60 rounded-lg border border-dashed p-4">
            <p className="text-foreground text-sm font-medium">{t("howTitle")}</p>
            <ul className="text-muted-foreground mt-2 space-y-2 text-xs leading-relaxed">
              <li className="flex items-start gap-2">
                <TerminalSquare className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("howOffline")}</span>
              </li>
              <li className="flex items-start gap-2">
                <LockKeyhole className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("howMfa")}</span>
              </li>
              <li className="flex items-start gap-2">
                <Link2 className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("howInvite")}</span>
              </li>
            </ul>
          </div>

          <Button
            variant="ghost"
            className="w-full"
            onClick={() => navigate({ kind: "dashboard" })}
          >
            <ArrowUpRight className="size-4" aria-hidden="true" />
            {tRoot("backToWorkspace")}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

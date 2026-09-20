"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useAppStore } from "@/store/app-store";
import { dirOf } from "@/i18n/config";
import { Splash } from "@/components/shared/primitives";
import { AuthView } from "@/modules/auth/auth-view";
import { OnboardingView, type CreatedBusiness } from "@/modules/onboarding/onboarding-view";
import { AppShell, useMembershipsQuery } from "./app-shell";

/**
 * Root orchestrator (single-page app shell).
 * Session gate -> business gate -> workspace.
 * NOTE: this environment exposes only the root route, so navigation is
 * state-based (documented in the worklog + architecture docs).
 */
export function AppRoot() {
  const { status } = useSession();
  const tShell = useTranslations("shell");
  const locale = useAppStore((s) => s.locale);
  const activeBusinessId = useAppStore((s) => s.activeBusinessId);
  const setActiveBusiness = useAppStore((s) => s.setActiveBusiness);
  const view = useAppStore((s) => s.view);

  // Hydration guard: persisted locale/business differ server vs client,
  // so render the splash until the client has mounted.
  // (useSyncExternalStore: server snapshot false, client snapshot true —
  // no setState-in-effect, no hydration mismatch.)
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // A05/A06 — drive <html> direction + language from the active locale.
  useEffect(() => {
    const dir = dirOf(locale);
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
  }, [locale]);

  const authenticated = status === "authenticated";

  const { data: memberships, isLoading: businessesLoading, isError } =
    useMembershipsQuery(authenticated);

  // Ensure a valid active business once memberships are known.
  useEffect(() => {
    if (!authenticated || !memberships) return;
    if (memberships.length === 0) return;
    const exists = memberships.some((m) => m.business.id === activeBusinessId);
    if (!exists) setActiveBusiness(memberships[0].business.id);
  }, [authenticated, memberships, activeBusinessId, setActiveBusiness]);

  if (status === "loading" || !mounted) {
    return <Splash label={tShell("loadingWorkspace")} />;
  }

  if (!authenticated) {
    return <AuthView />;
  }

  if (businessesLoading) {
    return <Splash label={tShell("loadingWorkspace")} />;
  }

  if (isError) {
    return (
      <Splash label="Unable to load your workspace. Please refresh." />
    );
  }

  const list = memberships ?? [];

  if (list.length === 0 || view.kind === "onboarding") {
    return (
      <OnboardingView
        onCreated={(b: CreatedBusiness) => {
          setActiveBusiness(b.business.id);
          useAppStore.getState().navigate({ kind: "dashboard" });
        }}
      />
    );
  }

  if (!activeBusinessId) {
    return <Splash label={tShell("loadingWorkspace")} />;
  }

  return <AppShell memberships={list} dir={dirOf(locale)} />;
}

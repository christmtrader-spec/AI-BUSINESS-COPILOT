"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useAppStore, hashToView, sameView } from "@/store/app-store";
import { dirOf } from "@/i18n/config";
import { Splash } from "@/components/shared/primitives";
import { AuthView } from "@/modules/auth/auth-view";
import { PlatformJoinView } from "@/modules/platform/platform-join-view";
import { ProfileView } from "@/modules/settings/profile-view";
import { VerifyEmailView } from "@/modules/settings/verify-email-view";
import { SecurityCenterView } from "@/modules/settings/security-view";
import { OnboardingView, type CreatedBusiness } from "@/modules/onboarding/onboarding-view";
import { JoinInviteView } from "@/modules/settings/join-invite-view";
import { AppShell, useMembershipsQuery } from "./app-shell";
import { PlatformRoot } from "@/modules/platform/platform-root";

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

  // Hash router: deep link on first mount + browser back/forward support.
  // navigate() pushes history entries; popstate/hashchange (user gestures)
  // mirror the URL back into the store without pushing again.
  useEffect(() => {
    const applyHash = () => {
      const next = hashToView(window.location.hash);
      const current = useAppStore.getState().view;
      // Structural compare (sameView, not viewKeyOf): a hash change that
      // only swaps the module sub-state (e.g. #/reports?month=…) must reach
      // the store WITHOUT remounting the module.
      if (!sameView(current, next)) {
        useAppStore.getState().replaceView(next);
      }
      // Invite links opened while signed OUT: park the token so we can
      // re-enter the join flow right after authentication.
      if (next.kind === "join") {
        try {
          window.localStorage.setItem("abc:pendingInvite", next.token);
        } catch {
          // storage unavailable — the user can reopen the link
        }
      }
    };
    applyHash();
    window.addEventListener("popstate", applyHash);
    window.addEventListener("hashchange", applyHash);
    return () => {
      window.removeEventListener("popstate", applyHash);
      window.removeEventListener("hashchange", applyHash);
    };
  }, []);

  // Prompt 25 — pricing CTA intent continuation. Query params are STRICTLY
  // allowlisted (plan code / period / currency — never amounts or book ids);
  // the intent is parked in sessionStorage for the onboarding flow and the
  // URL is cleaned so a refresh cannot replay the funnel event.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const intent = sp.get("intent");
    if (!intent) return;
    const planCodes = ["FREE", "STARTER", "BUSINESS", "PRO", "ENTERPRISE"];
    const period = sp.get("billingPeriod");
    const currency = sp.get("currency");
    const payload = {
      plan: planCodes.includes(intent) ? intent : null,
      billingPeriod: period === "MONTHLY" || period === "YEARLY" ? period : null,
      currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
    };
    try {
      window.sessionStorage.setItem("abc:pricingIntent", JSON.stringify(payload));
    } catch {
      // storage unavailable — the flow simply loses its preselection
    }
    // Funnel: arriving on the auth screen from a pricing CTA = signup start
    // (anonymous identity comes from the server-issued funnel cookie).
    void fetch("/api/public/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "SIGNUP_STARTED",
        planCode: payload.plan,
        billingPeriod: payload.billingPeriod,
        currency: payload.currency,
        source: "pricing-cta",
        route: "auth",
      }),
    }).catch(() => undefined);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Post-auth invite re-entry: once authenticated, a parked invite token
  // takes priority over the default landing view (exactly once).
  useEffect(() => {
    if (status !== "authenticated") return;
    let token: string | null = null;
    try {
      token = window.localStorage.getItem("abc:pendingInvite");
      window.localStorage.removeItem("abc:pendingInvite");
    } catch {
      return;
    }
    if (token && useAppStore.getState().view.kind !== "join") {
      useAppStore.getState().navigate({ kind: "join", token }, { replace: true });
    }
  }, [status]);

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

  // Password-flow views render EARLY and regardless of session state: a
  // signed-in user may open a reset link sent to another device, and after
  // a successful reset (or password change) every session dies anyway.
  if (view.kind === "forgot-password" || view.kind === "reset-password") {
    return <AuthView />;
  }

  // Prompt 30 §250 — the email-verification landing renders BEFORE the
  // auth gate: the confirm endpoint is anonymous-with-token (§161) and the
  // success state must be visible even for a signed-out user.
  if (view.kind === "verify-email") {
    return <VerifyEmailView token={view.token} />;
  }

  // R67 — platform operator invite redemption ALSO renders before the auth
  // gate: the opaque token is the authorization (§161 pattern), and a
  // super admin inviting a colleague may itself be signed in (the view is
  // account-scoped, never session-scoped).
  if (view.kind === "platform-join") {
    return <PlatformJoinView token={view.token} />;
  }

  if (!authenticated) {
    // R66 — an unauthenticated visitor to #/platform gets the PLATFORM
    // sign-in presentation directly (same NextAuth + MFA infrastructure,
    // platform branding only — §6 dedicated entry without a parallel auth
    // system). Every other unauthenticated state keeps the default view.
    return (
      <AuthView variant={view.kind === "platform" ? "platform" : "default"} />
    );
  }

  if (businessesLoading) {
    return <Splash label={tShell("loadingWorkspace")} />;
  }

  // Join-by-invite renders OUTSIDE the membership-gated shell — an invitee
  // may have zero businesses yet (that is the whole point of the link).
  if (view.kind === "join") {
    return <JoinInviteView token={view.token} />;
  }

  // Prompt 28 — the platform console is its OWN workspace: it renders
  // without any business context (an operator may own zero businesses) and
  // enforces its own authorization internally (server-derived, §11).
  if (view.kind === "platform") {
    return <PlatformRoot />;
  }

  if (isError) {
    return (
      <Splash label="Unable to load your workspace. Please refresh." />
    );
  }

  const list = memberships ?? [];

  // Prompt 18 §35 / Prompt 30 §92 — account lifecycle operations (profile,
  // account security) must NEVER require an active business: a user with
  // zero businesses can still manage their own account standalone.
  if (list.length === 0 && (view.kind === "profile" || view.kind === "settings:security")) {
    return (
      <main className="bg-background min-h-svh">
        <div className="mx-auto w-full max-w-2xl px-4 py-8">
          {view.kind === "settings:security" ? <SecurityCenterView /> : <ProfileView />}
        </div>
      </main>
    );
  }

  if (list.length === 0 || view.kind === "onboarding") {
    return (
      <OnboardingView
        onCreated={(b: CreatedBusiness) => {
          setActiveBusiness(b.business.id);
          useAppStore.getState().navigate({ kind: "dashboard" }, { replace: true });
        }}
      />
    );
  }

  if (!activeBusinessId) {
    return <Splash label={tShell("loadingWorkspace")} />;
  }

  return <AppShell memberships={list} dir={dirOf(locale)} />;
}

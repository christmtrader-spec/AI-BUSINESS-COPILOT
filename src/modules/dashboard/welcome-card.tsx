"use client";

/**
 * R140 — the USER-level welcome card (the R108 client consumer).
 *
 * The server contract (GET/PATCH /api/v1/me `checklistDismissedAt`, proven
 * by scripts/r108-me-checklist-api.ts) finally has its surface: the card
 * renders while the account has NEVER dismissed it, and a dismissal is a
 * SERVER fact — PATCH { checklistDismissed: true } — so it follows the user
 * across businesses and devices (unlike the business-level setup checklist,
 * which lives on onboardingDismissedAt). Restoring lives in
 * Settings → Profile (PATCH { checklistDismissed: false }).
 *
 * Honesty laws:
 *  - while /api/v1/me is loading the card renders NOTHING — no skeleton
 *    flash for veterans whose card is already dismissed;
 *  - the shared ["me"] query key means the card and the profile view read
 *    ONE cache — a dismissal here is instantly visible there;
 *  - the "Replay the product tour" affordance renders ONLY where the tour
 *    can honestly run (desktop viewport, data-writers — the same gates as
 *    <OnboardingTour>), and the tour listener re-guards anyway.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Bot, BarChart3, Loader2, PlayCircle, Sparkles, Users, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import { replayProductTour } from "@/modules/shell/onboarding-tour";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type MeWelcome = {
  name: string | null;
  // Additive: the R108 field. An older cached response honestly omits it —
  // an absent value reads as "never dismissed" (the card shows, the user
  // dismisses, the fresh response then carries the timestamp).
  checklistDismissedAt?: string | null;
};

export function WelcomeCard({ role }: { role: Role }) {
  const t = useTranslations("dashboard");
  const navigate = useAppStore((s) => s.navigate);
  const activeId = useAppStore((s) => s.activeBusinessId);
  const queryClient = useQueryClient();

  // The ONE account query — shared cache with Settings → Profile.
  const { data: me } = useQuery<MeWelcome>({
    queryKey: ["me"],
    queryFn: () => api("/api/v1/me", { businessId: null }),
    staleTime: 30_000,
  });

  // R154 — the conditional FOURTH tile (the standing conditional's twelfth
  // round, finally earned by onboarding data): a SOLO shop (the members
  // probe — the ONE ["members", activeId] query shared with Settings →
  // Members and the getting-started checklist) that the user can actually
  // manage (members:manage — OWNER/ADMIN) gets the invite tile. Laws:
  //  - the gate rides the business's OWN data, never a guess — while the
  //    probe is loading the tile is ABSENT (unknown → honest silence, no
  //    pop-in for a team that already exists);
  //  - a member-ful business never sees it (the need is gone);
  //  - the probe is the SAME cache entry the checklist reads — one fetch,
  //    two surfaces, no drift.
  const manage = can(role, "members:manage");
  const { data: members } = useQuery<{ id: string }[]>({
    queryKey: ["members", activeId],
    queryFn: () => api(`/api/v1/businesses/${activeId}/members`),
    enabled: !!activeId && manage,
    staleTime: 30_000,
  });
  const inviteTile = manage && members !== undefined && members.length <= 1;

  const dismiss = useMutation({
    mutationFn: async () =>
      api("/api/v1/me", {
        method: "PATCH",
        businessId: null,
        body: JSON.stringify({ checklistDismissed: true }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  // Gate law: unknown (loading) → honest silence; dismissed → gone.
  if (!me || me.checklistDismissedAt) return null;

  return (
    <Card
      className="border-primary/20 from-primary/5 bg-gradient-to-br to-transparent transition-shadow duration-200 hover:shadow-md"
      data-testid="welcome-card"
      data-view="welcome-card"
    >
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-primary size-4" aria-hidden="true" />
            <span className="gradient-warm">{t("welcomeCardTitle")}</span>
          </CardTitle>
          <CardDescription dir="auto">{t("welcomeCardDesc")}</CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => dismiss.mutate()}
          disabled={dismiss.isPending}
          aria-label={t("welcomeDismiss")}
          title={t("welcomeDismiss")}
          data-testid="welcome-card-dismiss"
        >
          {dismiss.isPending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <X className="size-4" aria-hidden="true" />
          )}
        </Button>
      </CardHeader>
      <CardContent>
        <ul
          className={cn("grid gap-2", inviteTile ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3")}
          data-testid="welcome-card-actions"
        >
          <li>
            <button
              type="button"
              data-testid="welcome-action-copilot"
              className="group hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-ring/40 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start text-sm transition-all focus-visible:outline-none focus-visible:ring-2 motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none"
              onClick={() => navigate({ kind: "module", module: "copilot" })}
            >
              <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md transition-colors group-hover:bg-primary/15">
                <Bot className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 truncate" dir="auto">
                {t("welcomeActionCopilot")}
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              data-testid="welcome-action-reports"
              className="group hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-ring/40 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start text-sm transition-all focus-visible:outline-none focus-visible:ring-2 motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none"
              onClick={() => navigate({ kind: "module", module: "reports" })}
            >
              <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md transition-colors group-hover:bg-primary/15">
                <BarChart3 className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 truncate" dir="auto">
                {t("welcomeActionReports")}
              </span>
            </button>
          </li>
          <li>
            {/* R154 — the conditional invite tile: a solo shop with the
                manage right gets the team handoff (the family byte-pattern,
                the Users icon = the checklist's own invite iconography). */}
            {inviteTile ? (
              <button
                type="button"
                data-testid="welcome-action-invite"
                className="group hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-ring/40 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start text-sm transition-all focus-visible:outline-none focus-visible:ring-2 motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none"
                onClick={() => navigate({ kind: "settings:members" })}
              >
                <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md transition-colors group-hover:bg-primary/15">
                  <Users className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 truncate" dir="auto">
                  {t("welcomeActionInvite")}
                </span>
              </button>
            ) : null}
          </li>
          <li>
            {/* The tour honestly needs the desktop sidebar anchors — the
                affordance is display:none (out of the a11y tree, out of the
                tab order) exactly where the tour would refuse to run. */}
            <button
              type="button"
              data-testid="welcome-action-tour"
              className="group hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-ring/40 hidden w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start text-sm transition-all focus-visible:outline-none focus-visible:ring-2 motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none lg:flex"
              onClick={() => replayProductTour()}
            >
              <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md transition-colors group-hover:bg-primary/15">
                <PlayCircle className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 truncate" dir="auto">
                {t("welcomeReplayTour")}
              </span>
            </button>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

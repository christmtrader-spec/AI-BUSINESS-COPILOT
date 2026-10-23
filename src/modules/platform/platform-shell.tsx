"use client";

/**
 * Platform operator shell — Prompt 28 (§15/§16/§17/§87).
 *
 * Sidebar information architecture (§87), permission-gated: sections the
 * operator's role cannot read are NOT rendered (hide, not disable). Uses
 * the same shadcn Sidebar primitives as the tenant shell so EN/FA, RTL/LTR,
 * dark/light, desktop (1280/1440) and mobile (390) behave identically.
 * There is deliberately NO platform navigation inside the tenant sidebar —
 * tenant users never see platform entries (§16); the console is reached by
 * operators directly (deep link / profile entry).
 *
 * R65 (§7.1) — the header now carries the operator IDENTITY: an account
 * menu (email + role + honest MFA chip) with "back to workspace", per-device
 * sign-out and a password-confirmed global sign-out. The approvals section
 * (§10 two-person control) joins the security group.
 */
import { lazy, Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import {
  Activity,
  Banknote,
  Bot,
  Building2,
  ClipboardCheck,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  MonitorSmartphone,
  PanelsTopLeft,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppStore, type PlatformSection } from "@/store/app-store";
import { dirOf } from "@/i18n/config";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { ApiClientError } from "@/lib/api-client";
import { signOutWithRevoke } from "@/lib/sign-out-with-revoke";
import { LocaleSwitcher, ThemeToggle } from "@/modules/shell/header";
import { PLATFORM_BRAND_BADGE, PLATFORM_GRADIENT_BG, PLATFORM_GRADIENT_SOFT } from "./kit";
import { platformSelfService, type PlatformSelf } from "./platform-api";

type NavEntry = {
  section: PlatformSection;
  labelKey: string;
  icon: LucideIcon;
  permission: string;
};

/** Hash section id → i18n label key (dash ids map to camelCase keys). */
const SECTION_LABELS: Record<PlatformSection, string> = {
  overview: "sections.overview",
  businesses: "sections.businesses",
  users: "sections.users",
  support: "sections.support",
  subscriptions: "sections.subscriptions",
  payments: "sections.payments",
  pricing: "sections.pricing",
  "ai-cost": "sections.aiCost",
  security: "sections.security",
  access: "sections.access",
  audit: "sections.audit",
  operators: "sections.operators",
  approvals: "sections.approvals",
  system: "sections.system",
};

const GROUPS: Array<{ labelKey: string; entries: NavEntry[] }> = [
  { labelKey: "groups.overview", entries: [{ section: "overview", labelKey: "sections.overview", icon: LayoutDashboard, permission: "platform:overview:read" }] },
  {
    labelKey: "groups.business",
    entries: [
      { section: "businesses", labelKey: "sections.businesses", icon: Building2, permission: "platform:businesses:read" },
      { section: "users", labelKey: "sections.users", icon: Users, permission: "platform:users:read" },
    ],
  },
  {
    labelKey: "groups.support",
    entries: [
      { section: "support", labelKey: "sections.support", icon: LifeBuoy, permission: "platform:support:read" },
    ],
  },
  {
    labelKey: "groups.billing",
    entries: [
      { section: "subscriptions", labelKey: "sections.subscriptions", icon: Wallet, permission: "platform:subscriptions:read" },
      { section: "payments", labelKey: "sections.payments", icon: Banknote, permission: "platform:payments:read" },
      { section: "pricing", labelKey: "sections.pricing", icon: PanelsTopLeft, permission: "platform:pricing:read" },
    ],
  },
  {
    labelKey: "groups.ai",
    entries: [
      { section: "ai-cost", labelKey: "sections.aiCost", icon: Bot, permission: "platform:ai-cost:read" },
    ],
  },
  {
    labelKey: "groups.security",
    entries: [
      { section: "audit", labelKey: "sections.audit", icon: ScrollText, permission: "platform:audit:read" },
      { section: "operators", labelKey: "sections.operators", icon: UsersRound, permission: "platform:operators:read" },
      { section: "security", labelKey: "sections.security", icon: ShieldCheck, permission: "platform:security:read" },
      // R67 §9 — the read-only role × permission matrix; every operator may
      // SEE the access model (same platform:overview:read as the overview).
      { section: "access", labelKey: "sections.access", icon: KeyRound, permission: "platform:overview:read" },
      // R65 §10 — two-person approval queue; every role can READ it.
      { section: "approvals", labelKey: "sections.approvals", icon: ClipboardCheck, permission: "platform:approvals:read" },
    ],
  },
  {
    labelKey: "groups.system",
    entries: [{ section: "system", labelKey: "sections.system", icon: Gauge, permission: "platform:system:read" }],
  },
];

export function PlatformShell({
  self,
  section,
}: {
  self: PlatformSelf;
  section: PlatformSection;
}) {
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);
  const locale = useAppStore((s) => s.locale);
  const [signOutAllOpen, setSignOutAllOpen] = useState(false);
  const can = (permission: string) => self.permissions.includes(permission);

  return (
    <SidebarProvider>
      <Sidebar side={dirOf(locale) === "rtl" ? "right" : "left"} collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            {/* R67 — brand paint: the platform gradient replaces the emerald
                box (brand, not semantic — status colors stay semantic). */}
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent ${PLATFORM_GRADIENT_BG}`}
            >
              <Activity className="size-4 text-white" aria-hidden="true" />
            </div>
            <div className="grid leading-tight group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-semibold">{t("title")}</span>
              <span className="text-muted-foreground text-xs">{t("subtitle")}</span>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {GROUPS.map((group) => {
            const visible = group.entries.filter((e) => can(e.permission));
            if (visible.length === 0) return null;
            return (
              <SidebarGroup key={group.labelKey}>
                <SidebarGroupLabel>{t(group.labelKey as Parameters<typeof t>[0])}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {visible.map((entry) => {
                      const active = section === entry.section;
                      return (
                        <SidebarMenuItem key={entry.section}>
                          <SidebarMenuButton
                            isActive={active}
                            aria-current={active ? "page" : undefined}
                            onClick={() => navigate({ kind: "platform", section: entry.section })}
                            // R67 — the active section carries the platform
                            // brand gradient (soft) instead of the sidebar
                            // accent; tailwind-merge lets these data-variant
                            // overrides win over the shadcn active classes,
                            // and the icon gets the brand tint (label keeps
                            // foreground text for contrast).
                            className={
                              active
                                ? `${PLATFORM_GRADIENT_SOFT} font-medium data-[active=true]:bg-transparent data-[active=true]:text-foreground`
                                : undefined
                            }
                          >
                            <entry.icon
                              className={`size-4 ${active ? "text-[#a13fd6] dark:text-[#C165DD]" : ""}`}
                              aria-hidden="true"
                            />
                            <span>{t(entry.labelKey as Parameters<typeof t>[0])}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </SidebarContent>
        <SidebarFooter>
          <div className="group-data-[collapsible=icon]:hidden px-2 py-1.5">
            <p className="text-muted-foreground truncate text-xs">
              {t("subtitle")}
            </p>
            <Badge variant="outline" className="mt-1">
              {t(`roles.${self.role}` as Parameters<typeof t>[0])}
            </Badge>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="bg-background/80 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger aria-label={t("toggleSidebar")} />
          <Separator orientation="vertical" className="mr-1 !h-5" />
          <h1 className="text-sm font-semibold">
            {t(SECTION_LABELS[section] as Parameters<typeof t>[0])}
          </h1>
          <div className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={() => navigate({ kind: "dashboard" })}
            >
              {t("backToWorkspace")}
            </Button>
            <LocaleSwitcher />
            <ThemeToggle />
            <IdentityMenu self={self} onSignOutAll={() => setSignOutAllOpen(true)} />
          </div>
        </header>
        <main id="platform-main" className="flex-1 p-4 md:p-6">
          <PlatformSectionContent section={section} />
        </main>
      </SidebarInset>
      {signOutAllOpen ? <SignOutAllDialog onClose={() => setSignOutAllOpen(false)} /> : null}
    </SidebarProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* R65 §7.1 — operator identity menu. The trigger is an icon button with an
/* aria-label (works identically on mobile); the content shows WHO is signed
/* in (mono email, role badge) and HOW securely (honest MFA chip — amber
/* "off" is never faked green), plus the three session-exit affordances.
/* -------------------------------------------------------------------------- */

function IdentityMenu({
  self,
  onSignOutAll,
}: {
  self: PlatformSelf;
  onSignOutAll: () => void;
}) {
  const t = useTranslations("platform");
  const navigate = useAppStore((s) => s.navigate);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("identity.menuLabel")} data-testid="pf-identity-trigger">
          <UserRound className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="space-y-1.5">
          <span className="text-muted-foreground text-xs font-normal">{t("identity.signedInAs")}</span>
          <span
            className="block truncate font-mono text-xs font-semibold"
            dir="ltr"
            data-testid="pf-identity-email"
          >
            {self.email}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Badge variant="outline">{t(`roles.${self.role}` as Parameters<typeof t>[0])}</Badge>
            {self.mfaEnabled ? (
              <Badge
                variant="outline"
                // R67 — brand paint: MFA-on was emerald; the on-state is now
                // the platform gradient badge (the honest amber off-state is
                // untouched — a warning is never brand paint).
                className={`${PLATFORM_BRAND_BADGE} gap-1`}
                data-testid="pf-identity-mfa-on"
              >
                <ShieldCheck className="size-3" aria-hidden="true" />
                {t("identity.mfaOn")}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400 gap-1"
                data-testid="pf-identity-mfa-off"
              >
                <ShieldAlert className="size-3" aria-hidden="true" />
                {t("identity.mfaOff")}
              </Badge>
            )}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ kind: "dashboard" })}>
          <PanelsTopLeft className="size-4" aria-hidden="true" />
          {t("backToWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="pf-identity-signout-device"
          onClick={() => void signOutWithRevoke("/")}
        >
          <LogOut className="size-4" aria-hidden="true" />
          {t("identity.signOutDevice")}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          data-testid="pf-identity-signout-all"
          onClick={onSignOutAll}
        >
          <MonitorSmartphone className="size-4" aria-hidden="true" />
          {t("identity.signOutAll")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Global sign-out (§80/§119): revoke-all needs the current password AND the
 * typed confirmation "SIGN OUT ALL". Best-effort law (§79): the sign-out
 * proceeds EVEN IF the revoke call fails — the failure is toasted honestly,
 * never swallowed and never shown as success.
 */
function SignOutAllDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("platform");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const CONFIRM_WORD = "SIGN OUT ALL";
  const canSubmit = password.length > 0 && confirmation.trim() === CONFIRM_WORD && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await platformSelfService.revokeAllSessions({
        password,
        confirmation: CONFIRM_WORD,
      });
      toast.success(t("identity.signOutAllSuccess", { count: res.revokedCount }));
    } catch (e) {
      // §79 best-effort law: the sign-out proceeds even when the revoke call
      // fails — the failure is toasted honestly, never shown as success. The
      // ONE exception is a wrong password (the user simply mistyped): keep
      // the dialog open for an honest retry instead of ejecting mid-edit.
      if (e instanceof ApiClientError && e.code === "INVALID_CURRENT_PASSWORD") {
        setError(t("identity.invalidPassword"));
        setSubmitting(false);
        return;
      }
      toast.error(t("identity.signOutAllFailed"));
    }
    await signOut({ callbackUrl: "/" });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="pf-signout-all-dialog">
        <DialogHeader>
          <DialogTitle>{t("identity.signOutAllTitle")}</DialogTitle>
          <DialogDescription>{t("identity.signOutAllDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pf-signout-all-password">{t("dialogs.currentPassword")}</Label>
            <Input
              id="pf-signout-all-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pf-signout-all-confirm">
              {t("dialogs.typedConfirmation", { word: CONFIRM_WORD })}
            </Label>
            <Input
              id="pf-signout-all-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              dir="ltr"
            />
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? t("common.working") : t("identity.signOutAllConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Section content — lazy so a tenant-role probe never downloads platform
 * view code (§16 spirit: no platform API prefetching for non-operators).
 */
const OverviewView = lazy(() => import("./overview-view").then((m) => ({ default: m.OverviewView })));
const BusinessesView = lazy(() => import("./businesses-view").then((m) => ({ default: m.BusinessesView })));
const UsersView = lazy(() => import("./users-view").then((m) => ({ default: m.UsersView })));
const SupportView = lazy(() => import("./support-view").then((m) => ({ default: m.SupportView })));
const SubscriptionsView = lazy(() => import("./subscriptions-view").then((m) => ({ default: m.SubscriptionsView })));
const PaymentsView = lazy(() => import("./payments-view").then((m) => ({ default: m.PaymentsView })));
const PricingView = lazy(() => import("./pricing-view").then((m) => ({ default: m.PricingView })));
const AiCostView = lazy(() => import("./ai-cost-view").then((m) => ({ default: m.AiCostView })));
const AuditView = lazy(() => import("./audit-view").then((m) => ({ default: m.PlatformAuditView })));
const SecurityView = lazy(() => import("./security-view").then((m) => ({ default: m.SecurityView })));
const OperatorsView = lazy(() => import("./operators-view").then((m) => ({ default: m.OperatorsView })));
const ApprovalsView = lazy(() => import("./approvals-view").then((m) => ({ default: m.ApprovalsView })));
const AccessView = lazy(() => import("./access-view").then((m) => ({ default: m.AccessView })));
const SystemView = lazy(() => import("./system-view").then((m) => ({ default: m.SystemView })));

function SectionFallback() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function PlatformSectionContent({ section }: { section: PlatformSection }) {
  switch (section) {
    case "overview":
      return <OverviewView />;
    case "businesses":
      return <BusinessesView />;
    case "users":
      return <UsersView />;
    case "support":
      return <SupportView />;
    case "subscriptions":
      return <SubscriptionsView />;
    case "payments":
      return <PaymentsView />;
    case "pricing":
      return <PricingView />;
    case "ai-cost":
      return <AiCostView />;
    case "audit":
      return <AuditView />;
    case "security":
      return <SecurityView />;
    case "operators":
      return <OperatorsView />;
    case "approvals":
      return <ApprovalsView />;
    case "access":
      return <AccessView />;
    case "system":
      return <SystemView />;
    default:
      return <OverviewView />;
  }
}

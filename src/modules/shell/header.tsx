"use client";

import { signOut, useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown, Languages, LogOut, Moon, Plus, Settings, Sun, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import { api } from "@/lib/api-client";
import { isLocale, localeLabel, LOCALES } from "@/i18n/config";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import type { BusinessListItem } from "./types";

export function LocaleSwitcher() {
  const tProfile = useTranslations("profile");
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={tProfile("language")}>
          <Languages className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => setLocale(l)}
            className={l === locale ? "bg-accent" : ""}
          >
            <Check className={`size-4 ${l === locale ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
            {localeLabel(l)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(["light", "dark", "system"] as const).map((mode) => (
          <DropdownMenuItem
            key={mode}
            onClick={() => setTheme(mode)}
            className={theme === mode ? "bg-accent" : ""}
          >
            <Check className={`size-4 ${theme === mode ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
            <span className="capitalize">{mode}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BusinessSwitcher({ memberships }: { memberships: BusinessListItem[] }) {
  const tShell = useTranslations("shell");
  const activeId = useAppStore((s) => s.activeBusinessId);
  const setActiveBusiness = useAppStore((s) => s.setActiveBusiness);
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();

  const active = memberships.find((m) => m.business.id === activeId) ?? memberships[0];

  function switchTo(id: string) {
    setActiveBusiness(id);
    navigate({ kind: "dashboard" });
    void queryClient.invalidateQueries();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[180px] gap-1.5 sm:max-w-[240px]">
          <span className="truncate font-medium">{active?.business.name ?? tShell("noBusinessYet")}</span>
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{tShell("businesses")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((m) => (
          <DropdownMenuItem key={m.business.id} onClick={() => switchTo(m.business.id)}>
            <Check
              className={`size-4 shrink-0 ${m.business.id === active?.business.id ? "opacity-100" : "opacity-0"}`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{m.business.name}</span>
              <span className="text-muted-foreground block text-xs">{m.business.currencyCode}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ kind: "onboarding" })}>
          <Plus className="size-4" aria-hidden="true" />
          {tShell("addBusiness")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UserMenu() {
  const tShell = useTranslations("shell");
  const tCommon = useTranslations("common");
  const { data: session } = useSession();
  const navigate = useAppStore((s) => s.navigate);

  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || email.slice(0, 2).toUpperCase() || "?";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={tShell("userMenu")}>
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <span className="block truncate text-sm">{name || email}</span>
          <span className="text-muted-foreground block truncate text-xs font-normal">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ kind: "profile" })}>
          <UserRound className="size-4" aria-hidden="true" />
          {tShell("myProfile")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate({ kind: "settings:business" })}>
          <Settings className="size-4" aria-hidden="true" />
          {tShell("businessSettings")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut({ callbackUrl: "/" })}>
          <LogOut className="size-4" aria-hidden="true" />
          {tCommon("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppHeader() {
  const tShell = useTranslations("shell");

  // Memberships for the switcher are cached by AppRoot via the same key.
  const { data: memberships } = useQuery<BusinessListItem[]>({
    queryKey: ["businesses"],
    queryFn: () => api("/api/v1/businesses", { businessId: null }),
    staleTime: 60_000,
  });

  const list = memberships ?? [];

  return (
    <header className="bg-background/80 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur sm:px-4">
      <SidebarTrigger aria-label={tShell("toggleSidebar")} />
      <Separator orientation="vertical" className="h-5" />
      <BusinessSwitcher memberships={list} />
      <div className="ms-auto flex items-center gap-1">
        <LocaleSwitcher />
        <ThemeToggle />
        <Separator orientation="vertical" className="mx-1 h-5" />
        <UserMenu />
      </div>
    </header>
  );
}

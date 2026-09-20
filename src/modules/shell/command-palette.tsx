"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import {
  ArrowUpRight,
  BarChart3,
  Bot,
  Check,
  CreditCard,
  HandCoins,
  Languages,
  LayoutDashboard,
  LogOut,
  Moon,
  Package,
  ScrollText,
  Settings,
  ShoppingCart,
  Sun,
  Truck,
  UserRound,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { LOCALES, localeLabel } from "@/i18n/config";
import { useAppStore, type AppView } from "@/store/app-store";
import { asRole, can, type Role } from "@/lib/rbac";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { BusinessListItem } from "./types";

type PaletteNavKey =
  | "dashboard"
  | "customers"
  | "suppliers"
  | "products"
  | "inventory"
  | "sales"
  | "expenses"
  | "payments"
  | "receivables"
  | "payables"
  | "copilot"
  | "reports"
  | "audit"
  | "teamMembers"
  | "settings"
  | "profile";

type PaletteItem = {
  view: AppView;
  labelKey: PaletteNavKey;
  icon: LucideIcon;
  permission?: "audit:read";
};

const NAV_ITEMS: PaletteItem[] = [
  { view: { kind: "dashboard" }, labelKey: "dashboard", icon: LayoutDashboard },
  { view: { kind: "module", module: "customers" }, labelKey: "customers", icon: Users },
  { view: { kind: "module", module: "suppliers" }, labelKey: "suppliers", icon: Truck },
  { view: { kind: "module", module: "products" }, labelKey: "products", icon: Package },
  { view: { kind: "module", module: "inventory" }, labelKey: "inventory", icon: Warehouse },
  { view: { kind: "module", module: "sales" }, labelKey: "sales", icon: ShoppingCart },
  { view: { kind: "module", module: "expenses" }, labelKey: "expenses", icon: Wallet },
  { view: { kind: "module", module: "payments" }, labelKey: "payments", icon: CreditCard },
  { view: { kind: "module", module: "receivables" }, labelKey: "receivables", icon: HandCoins },
  { view: { kind: "module", module: "payables" }, labelKey: "payables", icon: ArrowUpRight },
  { view: { kind: "module", module: "reports" }, labelKey: "reports", icon: BarChart3 },
  { view: { kind: "module", module: "copilot" }, labelKey: "copilot", icon: Bot },
  { view: { kind: "audit" }, labelKey: "audit", icon: ScrollText, permission: "audit:read" },
  { view: { kind: "settings:members" }, labelKey: "teamMembers", icon: Users },
  { view: { kind: "settings:business" }, labelKey: "settings", icon: Settings },
  { view: { kind: "profile" }, labelKey: "profile", icon: UserRound },
];

/**
 * ⌘K / Ctrl+K command palette — quick navigation + preferences.
 * Navigation respects RBAC the same way the sidebar does (UI-level only;
 * the server remains the authority — A02).
 */
export function CommandPalette({ membership }: { membership: BusinessListItem | null }) {
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const open = useAppStore((s) => s.commandOpen);
  const setOpen = useAppStore((s) => s.setCommandOpen);
  const navigate = useAppStore((s) => s.navigate);
  const setLocale = useAppStore((s) => s.setLocale);
  const locale = useAppStore((s) => s.locale);
  const { theme, setTheme } = useTheme();

  const role: Role = asRole(membership?.role);

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useAppStore.getState().commandOpen);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  function go(view: AppView) {
    setOpen(false);
    navigate(view);
  }

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  const navItems = NAV_ITEMS.filter(
    (n) => !n.permission || can(role, n.permission),
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={tCommon("palette.title")}
      description={tCommon("palette.description")}
    >
      <CommandInput placeholder={tCommon("palette.placeholder")} />
      <CommandList className="max-h-[min(26rem,60svh)]">
        <CommandEmpty>{tCommon("palette.empty")}</CommandEmpty>
        <CommandGroup heading={tCommon("palette.groups.navigate")}>
          {navItems.map((item) => (
            <CommandItem
              key={`nav-${item.labelKey}`}
              value={`${tNav(item.labelKey)} ${item.labelKey}`}
              onSelect={() => go(item.view)}
            >
              <item.icon className="text-muted-foreground" aria-hidden="true" />
              <span>{tNav(item.labelKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={tCommon("palette.groups.preferences")}>
          {(["light", "dark", "system"] as const).map((mode) => (
            <CommandItem
              key={`theme-${mode}`}
              value={`theme ${mode} ${tCommon(`palette.theme.${mode}`)}`}
              onSelect={() => {
                setTheme(mode);
                setOpen(false);
              }}
            >
              {mode === "light" ? (
                <Sun className="text-muted-foreground" aria-hidden="true" />
              ) : mode === "dark" ? (
                <Moon className="text-muted-foreground" aria-hidden="true" />
              ) : (
                <Settings className="text-muted-foreground" aria-hidden="true" />
              )}
              <span>{tCommon(`palette.theme.${mode}`)}</span>
              {theme === mode ? (
                <Check className="ms-auto size-4 opacity-100" aria-hidden="true" />
              ) : null}
            </CommandItem>
          ))}
          {LOCALES.map((l) => (
            <CommandItem
              key={`locale-${l}`}
              value={`language ${localeLabel(l)}`}
              onSelect={() => {
                setLocale(l);
                setOpen(false);
              }}
            >
              <Languages className="text-muted-foreground" aria-hidden="true" />
              <span>{localeLabel(l)}</span>
              {locale === l ? (
                <Check className="ms-auto size-4 opacity-100" aria-hidden="true" />
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={tCommon("palette.groups.session")}>
          <CommandItem
            value={tCommon("signOut")}
            onSelect={() => {
              setOpen(false);
              void signOut({ callbackUrl: "/" });
            }}
          >
            <LogOut className="text-muted-foreground" aria-hidden="true" />
            <span>{tCommon("signOut")}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div
        className="text-muted-foreground border-t px-3 py-2 text-[11px]"
        dir="ltr"
      >
        <kbd className="bg-muted rounded border px-1 font-sans">
          {isMac ? "⌘" : "Ctrl"}
        </kbd>
        <span className="mx-1">+</span>
        <kbd className="bg-muted rounded border px-1 font-sans">K</kbd>
        <span className="ms-2">{tCommon("palette.hint")}</span>
      </div>
    </CommandDialog>
  );
}

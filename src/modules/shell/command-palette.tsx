"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { signOutWithRevoke } from "@/lib/sign-out-with-revoke";
import { useTheme } from "next-themes";
// R150 — the ask-seed cap law (the composer's 500 is the authority).
import { askSeedFromFreeText } from "@/lib/ask-seed";
import {
  Bell,
  ClipboardList,
  Eraser,
  FileText,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bot,
  Check,
  CreditCard,
  FolderSync,
  HandCoins,
  KanbanSquare,
  Languages,
  LayoutDashboard,
  LifeBuoy,
  Loader2,
  LogOut,
  Moon,
  Package,
  PackageCheck,
  PackageMinus,
  PackageOpen,
  ReceiptText,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sun,
  Table2,
  Truck,
  UserRound,
  Users,
  Wallet,
  Warehouse,
  FileSignature,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import { LOCALES, localeLabel } from "@/i18n/config";
import {
  useAppStore,
  viewKeyOf,
  type AppView,
} from "@/store/app-store";
import { asRole, can, type Role } from "@/lib/rbac";
import { ApiClientError } from "@/lib/api-client";
import { fmtCount } from "../finance-shared/finance-kit";
// R133 — the ⌘K quick AI-usage dialog (read-only; the palette never
// executes mutations — this only INSPECTS server-counted usage, §1/§52).
import { UsageQuickDialog } from "@/modules/billing/usage-quick-dialog";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_Q_MIN,
  useSearchQuery,
} from "@/modules/search/search-api";
import { SEARCH_TYPE_ICONS } from "@/modules/search/search-icons";
import { entityViewFromSearchItem } from "@/modules/entities/entity-route";
import type { SearchResultItem } from "@/lib/search/types";
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
  | "goodsReceipts"
  | "goodsReturns"
  | "goodsDispatches"
  | "salesOrders"
  | "salesQuotations"
  | "supplierBills"
  | "purchaseOrders"
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
  | "billing"
  | "security"
  | "dataPortability"
  | "notifications"
  | "support"
  | "crm"
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
  // Prompt 42 (§118) — Goods Receipts reachable through the SAME palette.
  { view: { kind: "inventory-goods-receipts" }, labelKey: "goodsReceipts", icon: PackageCheck },
  // Prompt 43 (§90) — Goods Returns reachable through the SAME palette.
  { view: { kind: "inventory-goods-returns" }, labelKey: "goodsReturns", icon: PackageMinus },
  { view: { kind: "inventory-goods-dispatches" }, labelKey: "goodsDispatches", icon: PackageOpen },
  // Prompt 45 (§88) — Sales Orders reachable through the SAME palette.
  { view: { kind: "sales-orders" }, labelKey: "salesOrders", icon: FileText },
  // Prompt 47 — Sales Quotations reachable through the SAME palette.
  { view: { kind: "sales-quotations" }, labelKey: "salesQuotations", icon: FileSignature },
  // Prompt 48 (§4.3) — Supplier Bills reachable through the SAME palette.
  { view: { kind: "supplier-bills" }, labelKey: "supplierBills", icon: ReceiptText },
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
  { view: { kind: "settings:security" }, labelKey: "security", icon: ShieldCheck },
  { view: { kind: "profile" }, labelKey: "profile", icon: UserRound },
];

/**
 * R135 — destinations the RECENT group can label beyond NAV_ITEMS: the
 * sidebar-only vocabulary (billing/data/support/crm/purchase-orders/
 * notifications) so a recent destination is never a dead row. The labels
 * reuse the EXISTING nav.* i18n keys — zero new label vocabulary.
 */
const RECENT_EXTRA: PaletteItem[] = [
  { view: { kind: "crm", tab: "pipeline" }, labelKey: "crm", icon: KanbanSquare },
  { view: { kind: "purchase-orders" }, labelKey: "purchaseOrders", icon: ClipboardList },
  { view: { kind: "settings:billing" }, labelKey: "billing", icon: CreditCard },
  { view: { kind: "settings:data" }, labelKey: "dataPortability", icon: FolderSync },
  { view: { kind: "notifications" }, labelKey: "notifications", icon: Bell },
  { view: { kind: "support" }, labelKey: "support", icon: LifeBuoy },
];

/** ONE label authority for recents: NAV_ITEMS first, then the extras. */
const RECENT_SOURCES: PaletteItem[] = [...NAV_ITEMS, ...RECENT_EXTRA];

function recentLabelOf(view: AppView): PaletteItem | null {
  const key = viewKeyOf(view);
  return RECENT_SOURCES.find((n) => viewKeyOf(n.view) === key) ?? null;
}

/**
 * Prompt 33 §12 — the palette keeps ALL existing behavior (navigation,
 * preferences, session) and gains a UNIVERSAL SEARCH RESULTS group when the
 * query reaches 2+ characters. The CommandInput stays the single input;
 * requests are debounced and keyed per query so an older response can never
 * overwrite a newer one. Clicking a result only NAVIGATES — the palette is
 * a discovery layer and never executes mutations (§1).
 */
export function CommandPalette({ membership }: { membership: BusinessListItem | null }) {
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tSearch = useTranslations("search");
  // R150 — the ask door's tooltip rides the ONE generic seed-not-send hint
  // (the reports namespace — the same source every producer cites).
  const tAsk = useTranslations("reports");
  const open = useAppStore((s) => s.commandOpen);
  const setOpen = useAppStore((s) => s.setCommandOpen);
  const navigate = useAppStore((s) => s.navigate);
  const setLocale = useAppStore((s) => s.setLocale);
  const locale = useAppStore((s) => s.locale);
  const { theme, setTheme } = useTheme();

  // Controlled palette input + debounced mirror (§12.6, 200–300 ms).
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // R133 — the quick usage dialog opens FROM the palette (the palette
  // closes first; the dialog is a sibling, never nested in cmdk).
  const [usageOpen, setUsageOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(inputValue.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue]);

  // Reset the transient query when the palette OPENS so reopening starts
  // from a clean slate (render-phase state adjustment — the React-sanctioned
  // alternative to a setState-in-effect reset).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setInputValue("");
      setDebouncedQuery("");
    }
  }

  const search = useSearchQuery({ q: debouncedQuery, enabled: open });

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

  function openResult(item: SearchResultItem) {
    // §14/§33 — type+id resolve through the CLOSED entity vocabulary to the
    // exact entity detail; the palette never builds URLs from server data.
    go(entityViewFromSearchItem(item));
  }

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  const navItems = NAV_ITEMS.filter(
    (n) => !n.permission || can(role, n.permission),
  );

  const q = debouncedQuery;
  const searchActive = open && q.length >= SEARCH_Q_MIN;
  // R135 — the recent-destinations group (MRU, device-local, capped).
  // Recents render only in NAV mode: during an active search the results
  // come first (§31) and the group yields the floor honestly.
  const recentViews = useAppStore((s) => s.recentViews);
  const clearRecentViews = useAppStore((s) => s.clearRecentViews);
  const recentItems = searchActive
    ? []
    : recentViews
        .map((v) => ({ view: v, nav: recentLabelOf(v) }))
        .filter((r): r is { view: AppView; nav: PaletteItem } => r.nav !== null);
  const groups = search.data?.groups ?? [];
  const hasResults = groups.length > 0;

  return (
    <>
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={tCommon("palette.title")}
      description={tCommon("palette.description")}
    >
      <CommandInput
        value={inputValue}
        onValueChange={setInputValue}
        placeholder={tCommon("palette.placeholder")}
      />
      <CommandList className="max-h-[min(26rem,60svh)]">
        {!searchActive ? (
          <CommandEmpty>{tCommon("palette.empty")}</CommandEmpty>
        ) : null}

        {searchActive ? (
          <>
            {/* Loading state — rendered as a non-selectable status row so
                cmdk's empty state never flashes while fetching (§12.9). */}
            {search.isFetching && !hasResults ? (
              <CommandGroup heading={tSearch("title")}>
                <CommandItem disabled value={q}>
                  <Loader2 className="text-muted-foreground animate-spin" aria-hidden="true" />
                  <span>{tSearch("loading")}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}

            {/* Error state — localized, retryable, never leaks internals. */}
            {!search.isFetching && search.isError ? (
              <CommandGroup heading={tSearch("title")}>
                <CommandItem disabled value={q}>
                  <AlertTriangle className="text-destructive" aria-hidden="true" />
                  <span>
                    {search.error instanceof ApiClientError &&
                    search.error.code === "RATE_LIMITED"
                      ? tSearch("rateLimited")
                      : tSearch("error")}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}

            {/* Grouped results (§31 order: results first). */}
            {groups.map((group) => {
              const Icon = SEARCH_TYPE_ICONS[group.type];
              return (
                <CommandGroup
                  key={group.type}
                  heading={`${tSearch(`groups.${group.type}`)} · ${fmtCount(locale, group.count)}`}
                >
                  {group.items.map((item) => (
                    <CommandItem
                      key={`${item.type}-${item.id}`}
                      // The raw query rides along in the match value so
                      // cmdk's client-side filter can never hide a server
                      // result whose title happens not to contain it.
                      value={`${q} ${item.title} ${item.subtitle ?? ""}`}
                      onSelect={() => openResult(item)}
                    >
                      <Icon className="text-muted-foreground" aria-hidden="true" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate" dir="auto">
                          {item.title}
                        </span>
                        {item.subtitle ? (
                          <span className="text-muted-foreground truncate text-xs" dir="auto">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}

            {/* No-results state (only when settled and empty). R150 — the
                dead end grows a SELECTABLE door: the user's OWN query seeds
                the copilot composer (seed-not-send — askSeedFromFreeText is
                the composer's 500 cap authority; the door CLOSES the palette
                and navigates, exactly like every other go() here). The item
                is keyboard-reachable like every cmdk row — the palette is a
                keyboard surface, the door cannot be pointer-only. */}
            {!search.isFetching && !search.isError && !hasResults ? (
              <CommandGroup heading={tSearch("title")}>
                <CommandItem disabled value={q}>
                  <Search className="text-muted-foreground" aria-hidden="true" />
                  <span>{tSearch("empty")}</span>
                </CommandItem>
                {askSeedFromFreeText(q) ? (
                  <CommandItem
                    value={`ask-copilot ${q}`}
                    onSelect={() =>
                      go({ kind: "module", module: "copilot", ask: askSeedFromFreeText(q) })
                    }
                    title={tAsk("askCopilotHint")}
                    aria-label={tAsk("askCopilotHint")}
                    data-testid="palette-ask-copilot"
                  >
                    <Bot className="text-primary" aria-hidden="true" />
                    <span className="min-w-0 truncate" dir="auto">
                      {tSearch("askCopilotEmpty")} «{askSeedFromFreeText(q)}»
                    </span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}

            {/* §12.14 — View all search results → #/search?q=… */}
            {hasResults ? (
              <>
                <CommandItem
                  value={`${q} ${tSearch("viewAll")}`}
                  onSelect={() => go({ kind: "search", query: q })}
                >
                  <Table2 className="text-muted-foreground" aria-hidden="true" />
                  <span>{tSearch("viewAll")}</span>
                </CommandItem>
                <CommandSeparator />
              </>
            ) : null}
          </>
        ) : null}

        {recentItems.length > 0 ? (
          <>
            <CommandGroup heading={tCommon("palette.groups.recent")}>
              {recentItems.map(({ view, nav }) => (
                <CommandItem
                  key={`recent-${viewKeyOf(view)}`}
                  value={`${tNav(nav.labelKey)} ${nav.labelKey}`}
                  onSelect={() => go(view)}
                  data-testid={`palette-recent-${viewKeyOf(view)}`}
                >
                  <nav.icon className="text-muted-foreground" aria-hidden="true" />
                  <span>{tNav(nav.labelKey)}</span>
                </CommandItem>
              ))}
              <CommandItem
                value={tCommon("palette.clearRecent")}
                onSelect={() => clearRecentViews()}
                data-testid="palette-recent-clear"
                // R135 styling law — the clear row is a quiet destructive
                // action: muted at rest, destructive on hover, and it never
                // animates under motion-reduce.
                className="text-muted-foreground hover:text-destructive transition-colors motion-reduce:transition-none"
              >
                <Eraser
                  className="text-muted-foreground group-data-[selected=true]:text-destructive"
                  aria-hidden="true"
                />
                <span>{tCommon("palette.clearRecent")}</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}
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
        {/* R133 — Account group: the ⌘K path to the quick AI-usage view.
            Gated by settings:read — the exact permission the usage API
            itself requires (viewer roles see no dead command). */}
        {can(role, "settings:read") ? (
          <>
            <CommandGroup heading={tCommon("palette.groups.account")}>
              <CommandItem
                value={tCommon("palette.usageItem")}
                onSelect={() => {
                  setOpen(false);
                  setUsageOpen(true);
                }}
                data-testid="palette-usage-item"
              >
                <Gauge className="text-muted-foreground" aria-hidden="true" />
                <span>{tCommon("palette.usageItem")}</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}
        <CommandGroup heading={tCommon("palette.groups.session")}>
          <CommandItem
            value={tCommon("signOut")}
            onSelect={() => {
              setOpen(false);
              void signOutWithRevoke("/");
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
    {/* R135 — rendered as a SIBLING of the palette, never inside its
        DialogContent subtree. Radix unmounts the palette's content when it
        closes (no forceMount), which previously unmounted THIS dialog in
        the very batch that opened it: selecting "AI usage" closed the
        palette and the usage view silently never appeared — it only
        "zombied" back on the NEXT palette open (mounted with a stale
        usageOpen=true). As a sibling it mounts independently of the
        palette's open state, so one selection = palette closes AND the
        dialog opens in the same commit. */}
    <UsageQuickDialog
      open={usageOpen}
      onOpenChange={setUsageOpen}
      onOpenSubscription={() => {
        setUsageOpen(false);
        go({ kind: "settings:billing" });
      }}
    />
    </>
  );
}

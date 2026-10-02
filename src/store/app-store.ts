"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { registerBusinessIdProvider } from "@/lib/api-client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import {
  entityToHash,
  parseEntityRoute,
  type EntityType,
} from "@/lib/entity-routes";

/**
 * Global client state (Zustand). Server data lives in TanStack Query;
 * this store only holds UI/session preferences.
 * - locale persists (A05/A06)
 * - activeBusinessId persists; the SERVER re-verifies membership on
 *   every request (A01) — this value is a UX hint, never an authority.
 * - view is the current app module; it is MIRRORED to the URL hash
 *   (e.g. #/sales) so deep links, refresh persistence and browser
 *   back/forward work even though this environment only exposes "/".
 */
export type AppView =
  | { kind: "dashboard" }
  | { kind: "audit" }
  | { kind: "settings:business" }
  | { kind: "settings:members" }
  | { kind: "settings:billing" }
  | { kind: "settings:security" }
  /** Prompt 31 — customer data portability center (#/data, §123/§186). */
  | { kind: "settings:data" }
  /** Prompt 32 — notification center (#/notifications, §109) + preferences (#/settings/notifications, §63). */
  | { kind: "notifications" }
  | { kind: "settings:notifications" }
  /** Prompt 33 — Search Results Center (#/search, #/search?q=…, §13). */
  | { kind: "search"; query?: string }
  /**
   * Prompt 35 (§36/§37) — CRM module (#/crm). ONE view kind with a CLOSED
   * tab vocabulary (leads | pipeline | opportunities); the tab rides the
   * hash query (#/crm?tab=leads). Bare #/crm and unknown tabs resolve to
   * the documented deterministic default (pipeline).
   */
  | { kind: "crm"; tab: CrmTab }
  /**
   * Prompt 34 — Entity detail deep link (#/customers/<id>, §4/§5). The
   * entity is a CLOSED vocabulary token (lib/entity-routes) — never an
   * arbitrary string — and the id is validated by `parseEntityRoute`.
   */
  | { kind: "entity"; entity: EntityType; id: string }
  | { kind: "profile" }
  | { kind: "onboarding" }
  | { kind: "join"; token: string }
  | { kind: "forgot-password" }
  | { kind: "reset-password"; token: string }
  | { kind: "module"; module: string; /** optional sub-resource (e.g. reports ?month=YYYY-MM) */ param?: string }
  /** Prompt 28 — internal platform console (separate workspace, §15). */
  | { kind: "platform"; section: PlatformSection }
  /** Prompt 30 §250 — email verification landing (token from the email link). */
  | { kind: "verify-email"; token: string };

/**
 * Prompt 35 (§37) — closed CRM tab vocabulary.
 * Prompt 36 (§43/§54) — adds `tasks` (the work queue). There is NO
 * `activities` tab: activities are contextual timeline records rendered on
 * entity pages, never a standalone list (§54).
 */
export const CRM_TABS = ["leads", "pipeline", "opportunities", "tasks"] as const;
export type CrmTab = (typeof CRM_TABS)[number];

/**
 * Prompt 35 (§37) — the deterministic default tab for bare #/crm and for
 * unknown tab values: the pipeline board (documented in crm-foundation.md).
 */
export const CRM_DEFAULT_TAB: CrmTab = "pipeline";

export function isCrmTab(value: string): value is CrmTab {
  return (CRM_TABS as readonly string[]).includes(value);
}

export const KNOWN_MODULES = [
  "customers",
  "suppliers",
  "products",
  "inventory",
  "sales",
  "expenses",
  "payments",
  "receivables",
  "payables",
  "reports",
  "copilot",
] as const;

export type KnownModule = (typeof KNOWN_MODULES)[number];

/**
 * Prompt 28 — platform console sections (§15). `security` is the grouped
 * landing (audit + operators tabs per §87); `ai-cost` carries its internal
 * tabs inside the view (§38).
 */
export const PLATFORM_SECTIONS = [
  "overview",
  "businesses",
  "users",
  "subscriptions",
  "payments",
  "pricing",
  "ai-cost",
  "security",
  "audit",
  "operators",
  "system",
] as const;

export type PlatformSection = (typeof PLATFORM_SECTIONS)[number];

export function isPlatformSection(value: string): value is PlatformSection {
  return (PLATFORM_SECTIONS as readonly string[]).includes(value);
}

export function isKnownModule(value: string): value is KnownModule {
  return (KNOWN_MODULES as readonly string[]).includes(value);
}

/** Stable identity of a view (for equality checks / keys). */
export function viewKeyOf(view: AppView): string {
  return view.kind === "module"
    ? `module:${view.module}`
    // Prompt 35 — the tab is part of the key so tab switches remount the
    // inner CRM view deterministically.
    : view.kind === "crm"
      ? `crm:${view.tab}`
    // Prompt 34 — entity + id both matter: opening a different record
    // remounts the detail view so no stale record can ever be shown (§36).
    : view.kind === "entity"
      ? `entity:${view.entity}:${view.id}`
      : view.kind === "join"
      ? `join:${view.token}`
      : view.kind === "reset-password"
        ? `reset:${view.token}`
        : view.kind === "verify-email"
          ? `verify:${view.token}`
          : view.kind === "platform"
            ? `platform:${view.section}`
            // Prompt 33 — the Search Center keeps a STABLE view key so the
            // mounted view (and its focused input) survives query updates;
            // the query itself only matters for sameView/back-forward (§13).
            : view.kind;
}

/**
 * Structural view equality (applyHash). Deliberately FINER than viewKeyOf:
 * module sub-state (?month= deep-link param) must re-enter the store when
 * the hash changes, but must NOT remount the module (viewKey stays stable
 * so React keeps the mounted view alive — reports state survives dialog
 * open/close).
 */
export function sameView(a: AppView, b: AppView): boolean {
  if (viewKeyOf(a) !== viewKeyOf(b)) return false;
  if (a.kind === "module" && b.kind === "module") {
    return (a.param ?? null) === (b.param ?? null);
  }
  // Prompt 34 — entity views compare entity + id (viewKey already carries
  // both, so reaching here means they are equal; kept explicit for clarity).
  if (a.kind === "entity" && b.kind === "entity") {
    return a.entity === b.entity && a.id === b.id;
  }
  // Prompt 35 — CRM tab changes re-enter the store (back/forward) without
  // remounting the module boundary shell; the tab drives the inner view.
  if (a.kind === "crm" && b.kind === "crm") {
    return a.tab === b.tab;
  }
  // Prompt 33 — hash query changes re-enter the store (back/forward must
  // update the Search Center) without remounting the view (§13/§33).
  if (a.kind === "search" && b.kind === "search") {
    return (a.query ?? null) === (b.query ?? null);
  }
  return true;
}

/** URL hash for a view. `onboarding` is a transient state — no address. */
export function viewToHash(view: AppView): string | null {
  switch (view.kind) {
    case "dashboard":
      return "#/dashboard";
    case "audit":
      return "#/audit";
    case "settings:business":
      return "#/settings";
    case "settings:members":
      return "#/settings/members";
    case "settings:billing":
      return "#/settings/billing";
    case "profile":
      return "#/profile";
    case "settings:security":
      return "#/settings/security";
    case "settings:data":
      return "#/data";
    case "notifications":
      return "#/notifications";
    case "settings:notifications":
      return "#/settings/notifications";
    case "search": {
      // §33 — the query persists in the hash (encodeURIComponent, §29) so
      // refresh and back/forward keep it; never any other param.
      const q = (view.query ?? "").trim();
      return q ? `#/search?q=${encodeURIComponent(q)}` : "#/search";
    }
    case "crm":
      // Prompt 35 (§37) — the tab persists in the hash; the default tab
      // renders as bare "#/crm" so the address stays canonical.
      return view.tab === CRM_DEFAULT_TAB ? "#/crm" : `#/crm?tab=${view.tab}`;
    case "entity":
      // Prompt 34 — centralized encoder (§7/§39): validated entity + id,
      // safe-charset id, encodeURIComponent. Returns null (never a hash)
      // for anything that could not survive parseEntityRoute.
      return entityToHash(view.entity, view.id);
    case "platform":
      // #/platform itself resolves to the overview section (§15).
      return view.section === "overview" ? "#/platform" : `#/platform/${view.section}`;
    case "module": {
      if (!isKnownModule(view.module)) return null;
      // Module sub-state deep links (e.g. #/reports?month=YYYY-MM) stay in
      // the address bar — month is the only sub-param today.
      if (view.param && /^\d{4}-\d{2}$/.test(view.param)) {
        return `#/${view.module}?month=${view.param}`;
      }
      return `#/${view.module}`;
    }
    case "join":
      return `#/join/${view.token}`;
    case "forgot-password":
      return "#/forgot-password";
    case "reset-password":
      return `#/reset-password/${view.token}`;
    case "verify-email":
      return `#/verify-email/${view.token}`;
    case "onboarding":
      return null;
  }
}

/** Parse a location hash into a view. Unknown → dashboard (never onboarding). */
export function hashToView(hash: string): AppView {
  const raw = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  // Query part (e.g. #/reports?month=2026-04) — module-scoped deep-link params.
  const qIndex = raw.indexOf("?");
  const path = (qIndex === -1 ? raw : raw.slice(0, qIndex)).trim();
  const query = new URLSearchParams(qIndex === -1 ? "" : raw.slice(qIndex + 1));
  if (!path || path === "dashboard") return { kind: "dashboard" };
  if (path === "audit") return { kind: "audit" };
  if (path === "settings") return { kind: "settings:business" };
  if (path === "settings/members") return { kind: "settings:members" };
  if (path === "settings/billing") return { kind: "settings:billing" };
  if (path === "settings/security") return { kind: "settings:security" };
  if (path === "data") return { kind: "settings:data" };
  if (path === "notifications") return { kind: "notifications" };
  if (path === "settings/notifications") return { kind: "settings:notifications" };
  // Prompt 33 — Search Results Center deep links (#/search, #/search?q=…).
  if (path === "search") {
    const q = query.get("q") ?? "";
    const clean = sanitizeSearchHashQuery(q);
    return clean ? { kind: "search", query: clean } : { kind: "search" };
  }
  // Prompt 35 (§37) — CRM deep links: #/crm, #/crm?tab=<closed tab>.
  // Unknown tab values fall back to CRM_DEFAULT_TAB (pipeline) — the hash
  // query is never interpreted as arbitrary state.
  if (path === "crm") {
    const tab = query.get("tab") ?? "";
    return { kind: "crm", tab: isCrmTab(tab) ? tab : CRM_DEFAULT_TAB };
  }
  if (path === "profile") return { kind: "profile" };
  // Prompt 28 — platform console deep links (#/platform, #/platform/<section>).
  if (path === "platform") return { kind: "platform", section: "overview" };
  if (path.startsWith("platform/")) {
    const section = path.slice("platform/".length);
    if (isPlatformSection(section)) return { kind: "platform", section };
    return { kind: "platform", section: "overview" };
  }
  if (path.startsWith("join/")) {
    const token = path.slice("join/".length);
    // Opaque invite token: non-empty, bounded length (server validates the rest).
    if (token.length > 0 && token.length <= 128) return { kind: "join", token };
  }
  if (path === "forgot-password") return { kind: "forgot-password" };
  if (path.startsWith("verify-email/")) {
    const token = path.slice("verify-email/".length);
    // Opaque verification token: bounded length; the server validates the rest.
    if (token.length > 0 && token.length <= 200) return { kind: "verify-email", token };
    return { kind: "dashboard" };
  }
  if (path.startsWith("reset-password/")) {
    const token = path.slice("reset-password/".length);
    // Opaque reset token: non-empty, bounded length (server validates the rest).
    if (token.length > 0 && token.length <= 200) return { kind: "reset-password", token };
    // Malformed reset link → the forgot form so a fresh link can be requested.
    return { kind: "forgot-password" };
  }
  // Prompt 34 — entity detail deep links (#/customers/<id>, §5/§6) are
  // attempted BEFORE the bare-module match: "customers" alone stays the
  // module list while "customers/<id>" resolves through the centralized
  // parser (allowlisted first segment, bounded charset-safe id). Anything
  // else falls through to the dashboard fallback (§6.6) — never an
  // arbitrary "#/anything/<id>" interpretation.
  const entityRoute = parseEntityRoute(path);
  if (entityRoute) return { kind: "entity", ...entityRoute };
  if (isKnownModule(path)) {
    // Module sub-param deep links: ?month=YYYY-MM opens reports straight
    // into the drill-down, or pre-filters sales/expenses to that month
    // (e.g. "Open in Sales" from the reports month dialog).
    const month = query.get("month");
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      return { kind: "module", module: path, param: month };
    }
    return { kind: "module", module: path };
  }
  return { kind: "dashboard" };
}

/** Sync the URL to a view without triggering navigation events. */
function syncUrl(view: AppView, replace: boolean) {
  if (typeof window === "undefined") return;
  const hash = viewToHash(view);
  if (!hash) return;
  const target = `${window.location.pathname}${window.location.search}${hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === target) {
    return;
  }
  try {
    if (replace) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
  } catch {
    // history might be unavailable in exotic embeds — URL sync is best-effort
  }
}

/**
 * Prompt 33 — hash `?q=` hygiene (§16/§29): the query is rendered strictly
 * as text, so only control characters/null bytes are stripped and the
 * length is capped to the search schema bound. URLSearchParams already
 * performs percent-decoding; no other transformation is applied.
 */
function sanitizeSearchHashQuery(raw: string): string {
  const capped = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .slice(0, 64)
    .join("");
  const trimmed = capped.trim();
  return trimmed.length > 0 ? trimmed : "";
}

type AppState = {
  locale: Locale;
  activeBusinessId: string | null;
  view: AppView;
  commandOpen: boolean;
  setLocale: (locale: Locale) => void;
  setActiveBusiness: (id: string | null) => void;
  navigate: (view: AppView, opts?: { replace?: boolean }) => void;
  /** Back/forward + deep links: set view WITHOUT pushing a new history entry. */
  replaceView: (view: AppView) => void;
  setCommandOpen: (open: boolean) => void;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      locale: DEFAULT_LOCALE,
      activeBusinessId: null,
      view: { kind: "dashboard" },
      commandOpen: false,
      setLocale: (locale) => set({ locale }),
      setActiveBusiness: (activeBusinessId) => set({ activeBusinessId }),
      navigate: (view, opts) => {
        set({ view });
        syncUrl(view, opts?.replace ?? false);
      },
      replaceView: (view) => set({ view }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
    }),
    {
      name: "abc-preferences",
      partialize: (s) => ({
        locale: s.locale,
        activeBusinessId: s.activeBusinessId,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          locale: isLocale(p.locale) ? p.locale : DEFAULT_LOCALE,
          activeBusinessId:
            typeof p.activeBusinessId === "string" ? p.activeBusinessId : null,
        };
      },
    },
  ),
);

// Wire the API client to the active business context (x-business-id header).
registerBusinessIdProvider(() => useAppStore.getState().activeBusinessId);

"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { registerBusinessIdProvider } from "@/lib/api-client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";

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
  | { kind: "profile" }
  | { kind: "onboarding" }
  | { kind: "module"; module: string };

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

export function isKnownModule(value: string): value is KnownModule {
  return (KNOWN_MODULES as readonly string[]).includes(value);
}

/** Stable identity of a view (for equality checks / keys). */
export function viewKeyOf(view: AppView): string {
  return view.kind === "module" ? `module:${view.module}` : view.kind;
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
    case "profile":
      return "#/profile";
    case "module":
      return isKnownModule(view.module) ? `#/${view.module}` : null;
    case "onboarding":
      return null;
  }
}

/** Parse a location hash into a view. Unknown → dashboard (never onboarding). */
export function hashToView(hash: string): AppView {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  if (!path || path === "dashboard") return { kind: "dashboard" };
  if (path === "audit") return { kind: "audit" };
  if (path === "settings") return { kind: "settings:business" };
  if (path === "settings/members") return { kind: "settings:members" };
  if (path === "profile") return { kind: "profile" };
  if (isKnownModule(path)) return { kind: "module", module: path };
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

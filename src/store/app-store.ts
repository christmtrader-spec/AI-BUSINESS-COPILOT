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
 */
export type AppView =
  | { kind: "dashboard" }
  | { kind: "audit" }
  | { kind: "settings:business" }
  | { kind: "settings:members" }
  | { kind: "profile" }
  | { kind: "onboarding" }
  | { kind: "module"; module: string };

type AppState = {
  locale: Locale;
  activeBusinessId: string | null;
  view: AppView;
  setLocale: (locale: Locale) => void;
  setActiveBusiness: (id: string | null) => void;
  navigate: (view: AppView) => void;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      locale: DEFAULT_LOCALE,
      activeBusinessId: null,
      view: { kind: "dashboard" },
      setLocale: (locale) => set({ locale }),
      setActiveBusiness: (activeBusinessId) => set({ activeBusinessId }),
      navigate: (view) => set({ view }),
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

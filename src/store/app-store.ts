"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { registerBusinessIdProvider } from "@/lib/api-client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import {
  entityToHash,
  isValidEntityId,
  parseEntityRoute,
  type EntityType,
} from "@/lib/entity-routes";
import {
  isStatementTypeToken,
  type StatementTypeToken,
} from "@/lib/statements/types";
import {
  AGING_BUCKET_KEYS,
  type AgingBucketKey,
} from "@/lib/aging";
import type { LegalDocKey } from "@/config/legal";
import { isLegalDocKey } from "@/config/legal";

// Re-exported for view modules (legal/pricing render doc switches from the
// store's closed vocabulary — one import site for the whole app).
export type { LegalDocKey };

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
  /** Prompt 62 — Support Center (#/support): my tickets + thread. */
  | { kind: "support" }
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
  /**
   * Prompt 39 — Party statements (#/statements?type=customer|supplier&id=<id>,
   * §54–§59). The type is a CLOSED two-token vocabulary; the id must pass
   * the same safe-ID validation as entity routes. Unknown types and missing
   * or unsafe ids NEVER become state — they fall back to the dashboard like
   * every other unknown hash (§58).
   */
  | { kind: "statements"; statementType: StatementTypeToken; id: string }
  /**
   * Prompt 40 — Inventory stocktake views (§76/§77/§136): the LIST at
   * #/inventory/stocktakes and a DETAIL deep link at
   * #/inventory/stocktakes/<id>. The id is validated with the same
   * safe-ID rules as entity routes — malformed ids NEVER become state.
   */
  | { kind: "inventory-stocktakes" }
  | { kind: "inventory-stocktake"; id: string }
  /**
   * Prompt 41 — Purchase order views (§69/§70): the LIST at
   * #/purchase-orders and a DETAIL deep link at #/purchase-orders/<id>.
   * The id is validated with the same safe-ID rules as entity routes —
   * malformed ids NEVER become state (dashboard fallback).
   */
  | { kind: "purchase-orders" }
  | { kind: "purchase-order"; id: string }
  /**
   * Prompt 42 — Goods receipt views (§116): the LIST at
   * #/inventory/goods-receipts and a DETAIL deep link at
   * #/inventory/goods-receipts/<id>. The id is validated with the same
   * safe-ID rules as entity routes — malformed ids NEVER become state.
   */
  | { kind: "inventory-goods-receipts" }
  | { kind: "inventory-goods-receipt"; id: string }
  /**
   * Prompt 43 — Goods return views (§91): the LIST at
   * #/inventory/goods-returns and a DETAIL deep link at
   * #/inventory/goods-returns/<id>. The id is validated with the same
   * safe-ID rules as entity routes — malformed ids NEVER become state.
   */
  | { kind: "inventory-goods-returns" }
  | { kind: "inventory-goods-return"; id: string }
  /**
   * Prompt 44 — Goods dispatch views: the LIST at
   * #/inventory/goods-dispatches and a DETAIL deep link at
   * #/inventory/goods-dispatches/<id>. The id is validated with the same
   * safe-ID rules as entity routes — malformed ids NEVER become state.
   */
  | { kind: "inventory-goods-dispatches" }
  | { kind: "inventory-goods-dispatch"; id: string }
  /**
   * Prompt 45 — Sales order views: the LIST at #/sales-orders and a DETAIL
   * deep link at #/sales-orders/<id>. The id is validated with the same
   * safe-ID rules as entity routes — malformed ids NEVER become state.
   */
  | { kind: "sales-orders" }
  | { kind: "sales-order"; id: string }
  /**
   * Prompt 47 — Sales quotation views: the LIST at #/sales-quotations and
   * a DETAIL deep link at #/sales-quotations/<id>. The id is validated
   * with the same safe-ID rules as entity routes — malformed ids NEVER
   * become state (dashboard fallback).
   */
  | { kind: "sales-quotations" }
  | { kind: "sales-quotation"; id: string }
  /**
   * Prompt 48 — Supplier bill views: the LIST at #/supplier-bills and a
   * DETAIL deep link at #/supplier-bills/<id>. The id is validated with
   * the same safe-ID rules as every document deep link — malformed ids
   * NEVER become state (dashboard fallback). R86 — the list carries the
   * DEEP-LINKABLE breach filter (?pastDue=1, ?supplier=<safeId>): the
   * payables breach lane is a shareable URL, never just in-view state.
   */
  | { kind: "supplier-bills"; pastDue?: boolean; supplierId?: string }
  | { kind: "supplier-bill"; id: string }
  /**
   * Prompt 49 (§7/§11/§16) — DETAILED AGING drill-down: the open source
   * documents behind the aggregate aging. Reached from AgingCard buckets /
   * top parties / past-due chip and the 360 aging panels. Canonical filters
   * persist in the hash (#/reports/aging-details?…) so refresh and
   * back/forward stay correct; every filter is validated before it can
   * become state (§18 — invalid filters fall back safely, never a blank page).
   */
  | {
      kind: "aging-details";
      side: "receivables" | "payables";
      partyId?: string | null;
      bucket?: AgingBucketKey | null;
      pastDue?: boolean;
    }
  | { kind: "profile" }
  | { kind: "onboarding" }
  | { kind: "join"; token: string }
  /** Prompt 25/27 — public pricing page (#/pricing, anonymous-accessible).
   * The marketing surface: plan directory, availability, legal links. */
  | { kind: "pricing" }
  /** Prompt 27 — public legal documents (#/legal/<doc>, anonymous-
   * accessible). `doc` is the CLOSED config/legal vocabulary — unknown
   * docs NEVER become state (pricing fallback, §58 parity). */
  | { kind: "legal"; doc: LegalDocKey }
  /** R67 — platform operator invite redemption (#/platform-join/<token>).
   * Anonymous-with-token (§161 pattern): the OPAQUE token IS the
   * authorization; renders OUTSIDE the auth gate like verify-email. */
  | { kind: "platform-join"; token: string }
  | { kind: "forgot-password" }
  | { kind: "reset-password"; token: string }
  | { kind: "module"; module: string; /** optional sub-resource (e.g. reports ?month=YYYY-MM) */ param?: string;
      /** R87 — sales-only deep-linkable overdue worklist (?overdue=1).
       * Other modules NEVER grow the token (closed sub-state vocabulary). */
      overdue?: boolean;
      /** R88 — sales-only customer-scoped worklist (?customer=<safeId>) —
       * the Customer-360 drill landing. Charset-safe ids only. */
      customerId?: string;
      /** R100 — the reports performance sub-view (?perf=<closed token>)
       * rides AS the param ("perf-<token>") plus its optional ordered
       * window and the cashflow-only direction. The window is BOTH or
       * nothing (never one lying boundary); orphan window fields WITHOUT
       * a perf param cannot exist by parser law and never serialize. */
      perfFrom?: string;
      perfTo?: string;
      perfDirection?: "IN" | "OUT";
      /** R134 — the reports custom-range deep link (#/reports?from=&to=)
       * rides the SAME both-or-nothing ISO law as the perf window; mutually
       * exclusive with every other reports sub-view by parse precedence
       * (month → inventory → reorder → perf → range). Orphan/malformed
       * fields never serialize and never ride another module. */
      rangeFrom?: string;
      rangeTo?: string; }
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
 * tabs inside the view (§38). R65 (Prompt 65 §10) adds `approvals` — the
 * two-person approval queue.
 */
export const PLATFORM_SECTIONS = [
  "overview",
  "businesses",
  "users",
  "support",
  "subscriptions",
  "payments",
  "pricing",
  "ai-cost",
  "security",
  "access",
  "audit",
  "operators",
  "approvals",
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
    ? view.module === "sales"
      // R87/R88 — the sales worklist sub-state is part of the identity:
      // flipping the lane (or switching customer) re-enters the store.
      ? `module:sales:${view.param ?? ""}:${view.overdue ? 1 : 0}:${view.customerId ?? ""}`
      : `module:${view.module}`
    // Prompt 35 — the tab is part of the key so tab switches remount the
    // inner CRM view deterministically.
    : view.kind === "crm"
      ? `crm:${view.tab}`
    // Prompt 34 — entity + id both matter: opening a different record
    // remounts the detail view so no stale record can ever be shown (§36).
    : view.kind === "entity"
      ? `entity:${view.entity}:${view.id}`
    // Prompt 39 — type + id both matter: opening another party's statement
    // remounts the view so no stale statement can ever be shown (§159).
    : view.kind === "statements"
      ? `statements:${view.statementType}:${view.id}`
    // Prompt 40 — stocktake views: list + per-id detail keys so opening
    // another stocktake remounts the detail view (no stale record, §36 parity).
    : view.kind === "inventory-stocktakes"
      ? "inventory-stocktakes"
    : view.kind === "inventory-stocktake"
      ? `inventory-stocktake:${view.id}`
    // Prompt 41 — purchase-order views: list + per-id detail keys so opening
    // another order remounts the detail view (no stale record, §36 parity).
    : view.kind === "purchase-orders"
      ? "purchase-orders"
    : view.kind === "purchase-order"
      ? `purchase-order:${view.id}`
    // Prompt 42 — goods-receipt views: list + per-id detail keys so opening
    // another receipt remounts the detail view (no stale record, §36 parity).
    : view.kind === "inventory-goods-receipts"
      ? "inventory-goods-receipts"
    : view.kind === "inventory-goods-receipt"
      ? `inventory-goods-receipt:${view.id}`
    // Prompt 43 — goods-return views: list + per-id detail keys so opening
    // another return remounts the detail view (§36 parity).
    : view.kind === "inventory-goods-returns"
      ? "inventory-goods-returns"
    : view.kind === "inventory-goods-return"
      ? `inventory-goods-return:${view.id}`
    // Prompt 44 — goods-dispatch views: list + per-id detail keys so opening
    // another dispatch remounts the detail view (P43 parity).
    : view.kind === "inventory-goods-dispatches"
      ? "inventory-goods-dispatches"
    : view.kind === "inventory-goods-dispatch"
      ? `inventory-goods-dispatch:${view.id}`
    // Prompt 45 — sales-order views: list + per-id detail keys (§36 parity).
    : view.kind === "sales-orders"
      ? "sales-orders"
    : view.kind === "sales-order"
      ? `sales-order:${view.id}`
    // Prompt 47 — sales-quotation views: list + per-id detail keys.
    : view.kind === "sales-quotations"
      ? "sales-quotations"
    : view.kind === "sales-quotation"
      ? `sales-quotation:${view.id}`
    // Prompt 48 — supplier-bill views: list + per-id detail keys (§36 parity).
    : view.kind === "supplier-bills"
      // R86 — the breach filter is part of the view identity: toggling the
      // lane (or switching supplier) remounts with its own cursor/scroll.
      ? `supplier-bills:${view.pastDue ? 1 : 0}:${view.supplierId ?? ""}`
    : view.kind === "supplier-bill"
      ? `supplier-bill:${view.id}`
    // Prompt 49 — aging-details remounts on ANY filter change so each
    // side/party/bucket view holds its own cursor stack and scroll state.
    : view.kind === "aging-details"
      ? `aging-details:${view.side}:${view.partyId ?? ""}:${view.bucket ?? ""}:${view.pastDue ? 1 : 0}`
      : view.kind === "join"
      ? `join:${view.token}`
      // Prompt 27 — legal docs remount per document (TOC + scroll reset).
      : view.kind === "legal"
      ? `legal:${view.doc}`
      : view.kind === "pricing"
      ? "pricing"
      // R67 — token is part of the identity (each link remounts cleanly).
      : view.kind === "platform-join"
      ? `platform-join:${view.token}`
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
    // R87/R88 — the sales worklist sub-state is structural (sameView): a
    // hash change that only flips overdue/customer re-enters the store
    // WITHOUT remounting the module boundary shell.
    if (a.module === "sales" && b.module === "sales") {
      return (
        (a.param ?? null) === (b.param ?? null) &&
        (a.overdue ?? false) === (b.overdue ?? false) &&
        (a.customerId ?? null) === (b.customerId ?? null)
      );
    }
    // R100 — the reports perf sub-state is structural too: the SAME perf
    // param with a DIFFERENT window/direction re-enters the store (a second
    // chip opens a NEW answer window instead of remounting the shell).
    if (a.module === "reports" && b.module === "reports") {
      return (
        (a.param ?? null) === (b.param ?? null) &&
        (a.perfFrom ?? null) === (b.perfFrom ?? null) &&
        (a.perfTo ?? null) === (b.perfTo ?? null) &&
        (a.perfDirection ?? null) === (b.perfDirection ?? null) &&
        // R134 — a DIFFERENT custom range re-enters the store without
        // remounting the shell (the range effect applies it in place).
        (a.rangeFrom ?? null) === (b.rangeFrom ?? null) &&
        (a.rangeTo ?? null) === (b.rangeTo ?? null)
      );
    }
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
  // Prompt 39 — statement views compare type + id (viewKey already carries
  // both; explicit for parity with entity views).
  if (a.kind === "statements" && b.kind === "statements") {
    return a.statementType === b.statementType && a.id === b.id;
  }
  // Prompt 40 — stocktake detail compares id (viewKey already carries it).
  if (a.kind === "inventory-stocktake" && b.kind === "inventory-stocktake") {
    return a.id === b.id;
  }
  // Prompt 41 — purchase-order detail compares id (viewKey already carries it).
  if (a.kind === "purchase-order" && b.kind === "purchase-order") {
    return a.id === b.id;
  }
  // Prompt 42 — goods-receipt detail compares id (viewKey already carries it).
  if (a.kind === "inventory-goods-receipt" && b.kind === "inventory-goods-receipt") {
    return a.id === b.id;
  }
  // Prompt 43 — goods-return detail compares id (viewKey already carries it).
  if (a.kind === "inventory-goods-return" && b.kind === "inventory-goods-return") {
    return a.id === b.id;
  }
  // Prompt 44 — goods-dispatch detail compares id (viewKey already carries it).
  if (a.kind === "inventory-goods-dispatch" && b.kind === "inventory-goods-dispatch") {
    return a.id === b.id;
  }
  // Prompt 48 — supplier-bill detail compares id (viewKey already carries it).
  if (a.kind === "supplier-bill" && b.kind === "supplier-bill") {
    return a.id === b.id;
  }
  // Prompt 49 — aging-details compare every canonical filter: a hash change
  // on any of them re-enters the store (back/forward correctness, §18)
  // while viewKeyOf keeps the mounted view stable per filter combination.
  if (a.kind === "aging-details" && b.kind === "aging-details") {
    return (
      a.side === b.side &&
      (a.partyId ?? null) === (b.partyId ?? null) &&
      (a.bucket ?? null) === (b.bucket ?? null) &&
      Boolean(a.pastDue) === Boolean(b.pastDue)
    );
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
    case "support":
      return "#/support";
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
    case "statements":
      // Prompt 39 (§57/§139) — closed type + validated id only; anything
      // else produces no hash at all (never an arbitrary statement URL).
      if (!isStatementTypeToken(view.statementType)) return null;
      if (!isValidEntityId(view.id)) return null;
      return `#/statements?type=${view.statementType}&id=${encodeURIComponent(view.id)}`;
    case "inventory-stocktakes":
      // Prompt 40 (§76) — canonical list hash.
      return "#/inventory/stocktakes";
    case "inventory-stocktake":
      // Prompt 40 (§77/§136) — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/inventory/stocktakes/${view.id}`;
    case "purchase-orders":
      // Prompt 41 (§70) — canonical list hash.
      return "#/purchase-orders";
    case "purchase-order":
      // Prompt 41 (§70) — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/purchase-orders/${view.id}`;
    case "inventory-goods-receipts":
      // Prompt 42 (§116) — canonical list hash.
      return "#/inventory/goods-receipts";
    case "inventory-goods-receipt":
      // Prompt 42 (§116) — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/inventory/goods-receipts/${view.id}`;
    case "inventory-goods-returns":
      // Prompt 43 (§91) — canonical list hash.
      return "#/inventory/goods-returns";
    case "inventory-goods-return":
      // Prompt 43 (§91) — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/inventory/goods-returns/${view.id}`;
    case "inventory-goods-dispatches":
      // Prompt 44 — canonical list hash.
      return "#/inventory/goods-dispatches";
    case "inventory-goods-dispatch":
      // Prompt 44 — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/inventory/goods-dispatches/${view.id}`;
    case "sales-orders":
      // Prompt 45 (§88) — canonical list hash.
      return "#/sales-orders";
    case "sales-order":
      // Prompt 45 (§88) — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/sales-orders/${view.id}`;
    case "sales-quotations":
      // Prompt 47 — canonical list hash.
      return "#/sales-quotations";
    case "sales-quotation":
      // Prompt 47 — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/sales-quotations/${view.id}`;
    case "supplier-bills": {
      // R86 — canonical serializable breach lane: pastDue first, supplier
      // second (byte-identical round-trip; only charset-safe ids serialize).
      const params: string[] = [];
      if (view.pastDue) params.push("pastDue=1");
      if (view.supplierId && isValidEntityId(view.supplierId)) {
        params.push(`supplier=${encodeURIComponent(view.supplierId)}`);
      }
      return params.length ? `#/supplier-bills?${params.join("&")}` : "#/supplier-bills";
    }
    case "supplier-bill":
      // Prompt 48 — only charset-safe ids ever become a hash.
      if (!isValidEntityId(view.id)) return null;
      return `#/supplier-bills/${view.id}`;
    case "aging-details": {
      // Prompt 49 (§18) — canonical filter hash. A partyId that cannot
      // survive parsing produces NO hash (never a fake destination); the
      // bucket rides only when it is a closed bucket key; pastDue only on
      // the payables side (receivables have no authoritative due date).
      if (view.side !== "receivables" && view.side !== "payables") return null;
      if (view.partyId && !isValidEntityId(view.partyId)) return null;
      const params = new URLSearchParams({ side: view.side });
      if (view.partyId) params.set("party", view.partyId);
      if (view.bucket && (AGING_BUCKET_KEYS as readonly string[]).includes(view.bucket)) {
        params.set("bucket", view.bucket);
      }
      if (view.pastDue && view.side === "payables") params.set("pastDue", "1");
      return `#/reports/aging-details?${params.toString()}`;
    }
    case "platform":
      // #/platform itself resolves to the overview section (§15).
      return view.section === "overview" ? "#/platform" : `#/platform/${view.section}`;
    case "module": {
      if (!isKnownModule(view.module)) return null;
      // Module sub-state deep links stay in the address bar. Reports has
      // three: the month drill-down (?month=YYYY-MM), — Prompt 51 — the
      // detailed inventory valuation (?inventory=1) and — Prompt 55 —
      // the reorder suggestions (?reorder=1). Mutually exclusive.
      if (view.module === "reports" && view.param === "inventory") {
        return "#/reports?inventory=1";
      }
      if (view.module === "reports" && view.param === "reorder") {
        return "#/reports?reorder=1";
      }
      // R100 — the perf sub-view serializes canonically: perf → from → to
      // → direction. Orphan window/direction fields (no perf param) NEVER
      // serialize; the window rides only as a complete ordered pair and the
      // direction only on cashflow (defensive re-check on the way out too
      // — state can only ever come from the parser).
      if (view.module === "reports" && typeof view.param === "string" && view.param.startsWith("perf-")) {
        const token = view.param.slice("perf-".length);
        if (token === "sales" || token === "expenses" || token === "cashflow") {
          const parts: string[] = [`perf=${token}`];
          const iso = /^\d{4}-\d{2}-\d{2}$/;
          if (
            typeof view.perfFrom === "string" &&
            typeof view.perfTo === "string" &&
            iso.test(view.perfFrom) &&
            iso.test(view.perfTo) &&
            new Date(`${view.perfFrom}T00:00:00Z`).getTime() <= new Date(`${view.perfTo}T00:00:00Z`).getTime()
          ) {
            parts.push(`from=${view.perfFrom}`, `to=${view.perfTo}`);
          }
          if (token === "cashflow" && (view.perfDirection === "IN" || view.perfDirection === "OUT")) {
            parts.push(`direction=${view.perfDirection}`);
          }
          return `#/reports?${parts.join("&")}`;
        }
        return "#/reports";
      }
      if (view.param && /^\d{4}-\d{2}$/.test(view.param)) {
        // R87/R88 — canonical sales order: month → overdue → customer.
        if (view.module === "sales") {
          const parts: string[] = [`month=${view.param}`];
          if (view.overdue) parts.push("overdue=1");
          if (view.customerId && isValidEntityId(view.customerId)) {
            parts.push(`customer=${encodeURIComponent(view.customerId)}`);
          }
          return `#/sales?${parts.join("&")}`;
        }
        return `#/${view.module}?month=${view.param}`;
      }
      if (view.module === "sales") {
        // R87/R88 — canonical order overdue → customer; an unsafe id
        // serializes NO fragment (never a fake destination) but a safe
        // overdue flag still rides.
        const parts: string[] = [];
        if (view.overdue) parts.push("overdue=1");
        if (view.customerId && isValidEntityId(view.customerId)) {
          parts.push(`customer=${encodeURIComponent(view.customerId)}`);
        }
        return parts.length ? `#/sales?${parts.join("&")}` : "#/sales";
      }
      // R134 — the reports custom range serializes canonically
      // (#/reports?from=&to=) — BOTH or nothing (never one lying boundary),
      // ISO + non-inverted (the exact perf-window validation); orphan range
      // fields NEVER serialize and the fragment never rides another module.
      if (view.module === "reports") {
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        if (
          typeof view.rangeFrom === "string" &&
          typeof view.rangeTo === "string" &&
          iso.test(view.rangeFrom) &&
          iso.test(view.rangeTo) &&
          new Date(`${view.rangeFrom}T00:00:00Z`).getTime() <=
            new Date(`${view.rangeTo}T00:00:00Z`).getTime()
        ) {
          return `#/reports?from=${view.rangeFrom}&to=${view.rangeTo}`;
        }
      }
      return `#/${view.module}`;
    }
    case "join":
      return `#/join/${view.token}`;
    // Prompt 27 — canonical legal/pricing hashes (anonymous deep links).
    case "pricing":
      return "#/pricing";
    case "legal":
      return `#/legal/${view.doc}`;
    // R67 — platform operator invite redemption deep link.
    case "platform-join":
      return `#/platform-join/${view.token}`;
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
  if (path === "support") return { kind: "support" };
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
  // R67 — platform operator invite redemption deep link (before /platform so
  // the two prefixes never collide).
  if (path.startsWith("platform-join/")) {
    const token = path.slice("platform-join/".length);
    if (token.length > 0 && token.length <= 128) return { kind: "platform-join", token };
  }
  if (path === "forgot-password") return { kind: "forgot-password" };
  // Prompt 25/27 — public marketing + legal deep links (anonymous).
  if (path === "pricing") return { kind: "pricing" };
  if (path.startsWith("legal/")) {
    const doc = path.slice("legal/".length);
    // CLOSED vocabulary — unknown docs NEVER become state (pricing
    // fallback, the same safe-fallback law as every other deep link §58).
    if (isLegalDocKey(doc)) return { kind: "legal", doc };
    return { kind: "pricing" };
  }
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
  // Prompt 39 (§57/§58/§139) — statement deep links: #/statements with a
  // closed `type` token and a safe `id`. Unknown type / missing or unsafe
  // id → the existing unknown-hash fallback (dashboard); the query string
  // is never interpreted as arbitrary state.
  if (path === "statements") {
    const type = query.get("type") ?? "";
    const rawId = query.get("id") ?? "";
    if (!isStatementTypeToken(type)) return { kind: "dashboard" };
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "statements", statementType: type, id };
  }
  // Prompt 49 (§18) — detailed aging deep links:
  //   #/reports/aging-details?side=…&party=…&bucket=…&pastDue=1
  // EVERY filter falls back safely (never a blank page): an unknown side
  // defaults to receivables, an unknown bucket / unsafe party id is dropped,
  // pastDue is honored only on the payables side. The parsed party id is
  // resolved server-side inside the tenant — a foreign id renders the
  // honest not-found state (404), never another business's data.
  if (path === "reports/aging-details") {
    const side = query.get("side") === "payables" ? "payables" : "receivables";
    const rawBucket = query.get("bucket") ?? "";
    const bucket = (AGING_BUCKET_KEYS as readonly string[]).includes(rawBucket)
      ? (rawBucket as AgingBucketKey)
      : null;
    const rawParty = query.get("party") ?? "";
    let partyId: string | null = null;
    try {
      const decoded = rawParty ? decodeURIComponent(rawParty) : "";
      partyId = decoded && isValidEntityId(decoded) ? decoded : null;
    } catch {
      partyId = null;
    }
    const pastDue = side === "payables" && (query.get("pastDue") === "1" || query.get("pastDue") === "true");
    return { kind: "aging-details", side, bucket, partyId, pastDue };
  }
  // Prompt 40 (§76/§77/§136) — inventory stocktake deep links, matched
  // BEFORE the module/entity fallbacks: #/inventory/stocktakes opens the
  // list; #/inventory/stocktakes/<id> opens the detail only when the id is
  // charset-safe; anything else falls through to the dashboard fallback.
  if (path === "inventory/stocktakes") return { kind: "inventory-stocktakes" };
  if (path.startsWith("inventory/stocktakes/")) {
    const rawId = path.slice("inventory/stocktakes/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "inventory-stocktake", id };
  }
  // Prompt 41 (§69/§70) — purchase-order deep links, matched BEFORE the
  // module/entity fallbacks: #/purchase-orders opens the list;
  // #/purchase-orders/<id> opens the detail only when the id is charset-safe;
  // anything else falls through to the dashboard fallback.
  if (path === "purchase-orders") return { kind: "purchase-orders" };
  if (path.startsWith("purchase-orders/")) {
    const rawId = path.slice("purchase-orders/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "purchase-order", id };
  }
  // Prompt 42 (§116) — goods-receipt deep links, matched BEFORE the
  // module/entity fallbacks: #/inventory/goods-receipts opens the list;
  // #/inventory/goods-receipts/<id> opens the detail only when the id is
  // charset-safe; anything else falls through to the dashboard fallback.
  if (path === "inventory/goods-receipts") return { kind: "inventory-goods-receipts" };
  if (path.startsWith("inventory/goods-receipts/")) {
    const rawId = path.slice("inventory/goods-receipts/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "inventory-goods-receipt", id };
  }
  // Prompt 43 (§91) — goods-return deep links, matched BEFORE the
  // module/entity fallbacks: #/inventory/goods-returns opens the list;
  // #/inventory/goods-returns/<id> opens the detail only when the id is
  // charset-safe; anything else falls through to the dashboard fallback.
  if (path === "inventory/goods-returns") return { kind: "inventory-goods-returns" };
  if (path.startsWith("inventory/goods-returns/")) {
    const rawId = path.slice("inventory/goods-returns/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "inventory-goods-return", id };
  }
  // Prompt 44 — goods-dispatch deep links, matched BEFORE the
  // module/entity fallbacks: #/inventory/goods-dispatches opens the list;
  // #/inventory/goods-dispatches/<id> opens the detail only when the id is
  // charset-safe; anything else falls through to the dashboard fallback —
  // never an arbitrary "#/anything/<id>" interpretation.
  if (path === "inventory/goods-dispatches") return { kind: "inventory-goods-dispatches" };
  if (path.startsWith("inventory/goods-dispatches/")) {
    const rawId = path.slice("inventory/goods-dispatches/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "inventory-goods-dispatch", id };
  }
  // Prompt 45 — sales-order deep links, matched BEFORE the
  // module/entity fallbacks: #/sales-orders opens the list;
  // #/sales-orders/<id> opens the detail only when the id is charset-safe;
  // anything else falls through to the dashboard fallback — never an
  // arbitrary "#/anything/<id>" interpretation.
  if (path === "sales-orders") return { kind: "sales-orders" };
  if (path.startsWith("sales-orders/")) {
    const rawId = path.slice("sales-orders/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "sales-order", id };
  }
  // Prompt 47 — sales-quotation deep links, matched BEFORE the
  // module/entity fallbacks: #/sales-quotations opens the list;
  // #/sales-quotations/<id> opens the detail only when the id is
  // charset-safe; anything else falls through to the dashboard fallback —
  // never an arbitrary "#/anything/<id>" interpretation.
  if (path === "sales-quotations") return { kind: "sales-quotations" };
  if (path.startsWith("sales-quotations/")) {
    const rawId = path.slice("sales-quotations/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "sales-quotation", id };
  }
  // Prompt 48 — supplier-bill list + detail deep links (#/supplier-bills/<id>).
  // R86 — the list deep link carries the breach filter: ?pastDue=1 (only
  // the exact tokens 1/true — "yes"/"0"/empty DROP, never coerce) and
  // ?supplier=<safeId> (path-traversal/script-y ids NEVER become state).
  if (path === "supplier-bills") {
    const pastDueRaw = (query.get("pastDue") ?? "").trim();
    const supplierRaw = (query.get("supplier") ?? "").trim();
    const pastDue = pastDueRaw === "1" || pastDueRaw === "true" ? true : undefined;
    const supplierId =
      supplierRaw && isValidEntityId(supplierRaw) ? supplierRaw : undefined;
    return { kind: "supplier-bills", pastDue, supplierId };
  }
  if (path.startsWith("supplier-bills/")) {
    const rawId = path.slice("supplier-bills/".length);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { kind: "dashboard" };
    }
    if (!isValidEntityId(id)) return { kind: "dashboard" };
    return { kind: "supplier-bill", id };
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
    // (e.g. "Open in Sales" from the reports month dialog). Prompt 51:
    // ?inventory=1 opens the detailed inventory valuation sub-view.
    const month = query.get("month");
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      // R87/R88 — the sales worklist composes with the month drill-down:
      // month → overdue → customer (canonical order both ways).
      if (path === "sales") {
        const overdueRaw = (query.get("overdue") ?? "").trim();
        const customerRaw = (query.get("customer") ?? "").trim();
        return {
          kind: "module",
          module: path,
          param: month,
          overdue: overdueRaw === "1" || overdueRaw === "true" ? true : undefined,
          customerId:
            customerRaw && isValidEntityId(customerRaw) ? customerRaw : undefined,
        };
      }
      return { kind: "module", module: path, param: month };
    }
    if (path === "reports" && query.get("inventory") === "1") {
      return { kind: "module", module: path, param: "inventory" };
    }
    // Prompt 55 (§X2) — ?reorder=1 opens the low-stock reorder suggestions
    // sub-view. Closed token, never arbitrary state.
    if (path === "reports" && query.get("reorder") === "1") {
      return { kind: "module", module: path, param: "reorder" };
    }
    // R100 — the performance sub-view: ?perf=<sales|expenses|cashflow>
    // (CLOSED vocabulary, case-strict) with an OPTIONAL ordered window
    // (?from=&to= — BOTH or nothing, ISO dates, never inverted) and the
    // CASHFLOW-ONLY direction (?direction=IN|OUT). Every malformed piece is
    // DROPPED, never faked: an unknown token is not a sub-view at all, a
    // half/inverted/malformed window is dropped wholesale, and a garbage
    // direction drops only the direction (the window survives).
    if (path === "reports" && query.has("perf")) {
      const perf = (query.get("perf") ?? "").trim();
      if (perf === "sales" || perf === "expenses" || perf === "cashflow") {
        const from = query.get("from") ?? "";
        const to = query.get("to") ?? "";
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        let window: { perfFrom: string; perfTo: string } | Record<string, never> = {};
        if (iso.test(from) && iso.test(to)) {
          const f = new Date(`${from}T00:00:00Z`).getTime();
          const t = new Date(`${to}T00:00:00Z`).getTime();
          if (!Number.isNaN(f) && !Number.isNaN(t) && f <= t) window = { perfFrom: from, perfTo: to };
        }
        const dirRaw = (query.get("direction") ?? "").trim();
        const direction: { perfDirection?: "IN" | "OUT" } =
          perf === "cashflow" && (dirRaw === "IN" || dirRaw === "OUT")
            ? { perfDirection: dirRaw as "IN" | "OUT" }
            : {};
        return { kind: "module", module: path, param: `perf-${perf}`, ...window, ...direction };
      }
      // Unknown / case-mismatched token → plain reports (never a fake sub-view).
      return { kind: "module", module: path };
    }
    // R87/R88 — the SALES-ONLY worklist deep link (?overdue=1,
    // ?customer=<safeId>). The closed-token law drops garbage — "0"/"yes"/
    // script-y/traversal ids NEVER become state; other modules ignore the
    // params entirely (the sub-state vocabulary never grows sideways).
    if (path === "sales") {
      const overdueRaw = (query.get("overdue") ?? "").trim();
      const customerRaw = (query.get("customer") ?? "").trim();
      return {
        kind: "module",
        module: path,
        overdue: overdueRaw === "1" || overdueRaw === "true" ? true : undefined,
        customerId:
          customerRaw && isValidEntityId(customerRaw) ? customerRaw : undefined,
      };
    }
    // R134 — the reports custom-range deep link (?from=&to=): BOTH or
    // nothing, ISO keys, never inverted — the exact validation family of
    // the perf window. Every malformed piece drops WHOLESALE (bare reports,
    // never a half-open range); it is mutually exclusive with the other
    // reports sub-views by parse precedence (they returned above; a perf
    // URL consumes from/to as ITS window and never leaks range state).
    if (path === "reports") {
      const from = query.get("from") ?? "";
      const to = query.get("to") ?? "";
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (iso.test(from) && iso.test(to)) {
        const f = new Date(`${from}T00:00:00Z`).getTime();
        const t = new Date(`${to}T00:00:00Z`).getTime();
        if (!Number.isNaN(f) && !Number.isNaN(t) && f <= t) {
          return { kind: "module", module: path, rangeFrom: from, rangeTo: to };
        }
      }
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

// ---------------------------------------------------------------------------
// R135 — ⌘K RECENT DESTINATIONS (device-local, closed vocabulary)
//
// The command palette gains a "Recent" group: the last destinations the user
// NAVIGATED to. Laws:
// - INTENT-ONLY RECORDING — navigate() records; replaceView() never does, so
//   browser back/forward and hash re-entry (app-root applyHash) cannot churn
//   the list. Recents mean "where I chose to go", not "where history passed".
// - CLOSED GATE — isRecentDestination accepts exactly the palette-labelable
//   destination vocabulary (bare modules, list kinds, settings/support/
//   notifications pages, CRM tabs). Detail views (entity/statements/stocktake/
//   purchase-order/goods-receipt/…), aging-details, the search center and
//   module sub-states (sales lanes, reports perf/range windows) NEVER record:
//   recents are DESTINATIONS, not documents or answer windows — and every
//   recent must have a palette label (an unlabeled recent would be a
//   dead row). inventory-stocktakes and settings:notifications have no
//   palette label today, so they are outside the gate too.
// - MRU + DEDUPE + CAP — pushRecent moves an existing entry to the front
//   (viewKeyOf equality — ONE authority with the router) and evicts the
//   oldest beyond RECENT_VIEWS_CAP.
// - DEVICE-LOCAL — recentViews rides the existing "abc-preferences" persist
//   (same family as locale/activeBusinessId); it is UI state and is never
//   sent to the server (the API client carries only the business context).
// - BUSINESS-SCOPED — switching the active business CLEARS the list: ids are
//   never recorded (the gate forbids detail views), so nothing can leak
//   across businesses, and the palette stays honest about "where you have
//   been" in THIS business.
// - PARSE LAW — parseRecentViews validates persisted JSON entry-by-entry: a
//   non-array is wholesale [], a malformed/closed-vocabulary-violating entry
//   is dropped INDIVIDUALLY, surviving views are rebuilt to their minimal
//   canonical shape (persisted extra fields stripped), deduped and capped.
// ---------------------------------------------------------------------------

/** The palette shows at most five recent destinations. */
export const RECENT_VIEWS_CAP = 5;

/** Bare modules the palette can label (the palette's NAV_ITEMS vocabulary). */
const RECENT_MODULES = [
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

/** Bare (field-free) destination kinds the palette can label. */
const RECENT_KINDS = [
  "dashboard",
  "audit",
  "profile",
  "support",
  "notifications",
  "settings:business",
  "settings:members",
  "settings:billing",
  "settings:security",
  "settings:data",
  "inventory-goods-receipts",
  "inventory-goods-returns",
  "inventory-goods-dispatches",
  "sales-orders",
  "sales-quotations",
  "supplier-bills",
  "purchase-orders",
] as const;

/**
 * The record gate — ONE closed vocabulary of recentable destinations.
 * Battery-pinned (r135-palette-recents-check): every gate acceptance has a
 * palette label; every exclusion is a document/answer-window/unlabeled view.
 */
export function isRecentDestination(view: AppView): boolean {
  if ((RECENT_KINDS as readonly string[]).includes(view.kind)) return true;
  if (view.kind === "module") {
    return (
      (RECENT_MODULES as readonly string[]).includes(view.module) &&
      view.param == null &&
      !view.overdue &&
      view.customerId == null &&
      view.perfFrom == null &&
      view.perfTo == null &&
      view.perfDirection == null &&
      view.rangeFrom == null &&
      view.rangeTo == null
    );
  }
  if (view.kind === "crm") return CRM_TABS.includes(view.tab);
  return false;
}

/**
 * Pure MRU push — dedupe by viewKeyOf (one authority with the router),
 * evict the oldest beyond the cap. A non-destination view returns the SAME
 * array (the caller's set() can skip the recents key entirely).
 */
export function pushRecent(list: AppView[], view: AppView): AppView[] {
  if (!isRecentDestination(view)) return list;
  const key = viewKeyOf(view);
  const rest = list.filter((v) => viewKeyOf(v) !== key);
  return [view, ...rest].slice(0, RECENT_VIEWS_CAP);
}

/**
 * Persist-merge validator — entry-level honesty: garbage entries are dropped
 * INDIVIDUALLY (one stale entry never poisons the whole list), surviving
 * views are rebuilt to their minimal canonical shape (persisted extra fields
 * are stripped), then deduped and capped through the same pushRecent law.
 */
export function parseRecentViews(input: unknown): AppView[] {
  if (!Array.isArray(input)) return [];
  // pushRecent is PURE (it returns a new list, never mutates) — the loop
  // must REASSIGN, exactly like the store's navigate() does.
  let out: AppView[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    const kind = rec.kind;
    if (typeof kind !== "string") continue;
    let view: AppView | null = null;
    if ((RECENT_KINDS as readonly string[]).includes(kind)) {
      // Bare kinds carry no fields — rebuild minimal (strips extras).
      view = { kind } as AppView;
    } else if (kind === "module") {
      const mod = rec.module;
      if (typeof mod === "string" && (RECENT_MODULES as readonly string[]).includes(mod)) {
        view = { kind: "module", module: mod };
      }
    } else if (kind === "crm") {
      const tab = rec.tab;
      if (typeof tab === "string" && (CRM_TABS as readonly string[]).includes(tab)) {
        view = { kind: "crm", tab: tab as CrmTab };
      }
    }
    if (view) out = pushRecent(out, view);
  }
  return out;
}

type AppState = {
  locale: Locale;
  activeBusinessId: string | null;
  view: AppView;
  commandOpen: boolean;
  /**
   * R135 — device-local recent destinations for the ⌘K palette (MRU order,
   * capped at RECENT_VIEWS_CAP, recorded only by navigate() through the
   * isRecentDestination gate). Persisted with the preferences family and
   * validated on rehydration by parseRecentViews.
   */
  recentViews: AppView[];
  /** R135 — explicit clear (the palette's "Clear recent destinations" row). */
  clearRecentViews: () => void;
  /**
   * Prompt 25/27 — auth surface the join/sign-in card should show. The
   * legal & pricing pages flip this BEFORE navigating to the dashboard so
   * the auth card opens on the intended mode (never a second click).
   * Never persisted — the default is the calm "signin".
   */
  authMode: "signin" | "signup";
  setAuthMode: (mode: "signin" | "signup") => void;
  /**
   * Prompt 52 §F2 — cross-view quick-action intents ("New invoice" on the
   * dashboard opens the create dialog inside the target module). The `seq`
   * makes every fire unique so the same action can fire twice in a row.
   * Never persisted; consumed by the target view on mount/observation.
   */
  quickIntent: { action: "new-sale" | "new-expense" | "new-payment"; seq: number } | null;
  setLocale: (locale: Locale) => void;
  setActiveBusiness: (id: string | null) => void;
  navigate: (view: AppView, opts?: { replace?: boolean }) => void;
  /** Back/forward + deep links: set view WITHOUT pushing a new history entry. */
  replaceView: (view: AppView) => void;
  setCommandOpen: (open: boolean) => void;
  fireQuickIntent: (action: "new-sale" | "new-expense" | "new-payment") => void;
  consumeQuickIntent: () => void;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      locale: DEFAULT_LOCALE,
      activeBusinessId: null,
      view: { kind: "dashboard" },
      commandOpen: false,
      quickIntent: null,
      authMode: "signin",
      setAuthMode: (authMode) => set({ authMode }),
      setLocale: (locale) => set({ locale }),
      // R135 — a business switch starts a fresh recents session (business-
      // scoped law): the same-id re-set is a no-op for the list.
      setActiveBusiness: (activeBusinessId) =>
        set((s) => ({
          activeBusinessId,
          recentViews:
            s.activeBusinessId === activeBusinessId ? s.recentViews : [],
        })),
      recentViews: [],
      // R135 — navigate() is the ONLY recorder: replaceView() (back/forward
      // + deep-link re-entry) deliberately never touches recentViews.
      navigate: (view, opts) => {
        set((s) => ({ view, recentViews: pushRecent(s.recentViews, view) }));
        syncUrl(view, opts?.replace ?? false);
      },
      replaceView: (view) => set({ view }),
      clearRecentViews: () => set({ recentViews: [] }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      fireQuickIntent: (action) =>
        set({ quickIntent: { action, seq: Date.now() + Math.random() } }),
      consumeQuickIntent: () => set({ quickIntent: null }),
    }),
    {
      name: "abc-preferences",
      partialize: (s) => ({
        locale: s.locale,
        activeBusinessId: s.activeBusinessId,
        recentViews: s.recentViews,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          locale: isLocale(p.locale) ? p.locale : DEFAULT_LOCALE,
          activeBusinessId:
            typeof p.activeBusinessId === "string" ? p.activeBusinessId : null,
          // R135 — the persisted recents list re-validates entry-by-entry
          // (parseRecentViews law): a stale/foreign shape can never become
          // state.
          recentViews: parseRecentViews(p.recentViews),
        };
      },
    },
  ),
);

// Wire the API client to the active business context (x-business-id header).
registerBusinessIdProvider(() => useAppStore.getState().activeBusinessId);

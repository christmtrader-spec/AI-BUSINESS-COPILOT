"use client";

/**
 * Prompt 34 — client-side entity navigation helpers (§5/§23/§34/§38).
 * Thin wrappers over the store + lib/entity-routes: the ONLY way UI code
 * navigates to an entity. No view constructs hashes by hand.
 */

import {
  CRM_ENTITY_TAB,
  ENTITY_ROUTES,
  SEARCH_TYPE_TO_ENTITY,
  type EntityType,
} from "@/lib/entity-routes";
import type { SearchResultItem } from "@/lib/search/types";
import { useAppStore, type AppView } from "@/store/app-store";

/** Build the entity detail view (validated; throws on programmer error). */
export function entityView(entity: EntityType, id: string): AppView {
  return { kind: "entity", entity, id };
}

/**
 * Search result → view (§33/§64): the item's closed type token maps through
 * SEARCH_TYPE_TO_ENTITY; the id passes through unchanged (it is re-validated
 * by entityToHash when the hash is built).
 * Prompt 41 (§67/§152) — PURCHASE_ORDER is NOT an entity-router record: its
 * result deep-links to the dedicated #/purchase-orders/<id> view.
 */
export function entityViewFromSearchItem(item: SearchResultItem): AppView {
  if (item.type === "PURCHASE_ORDER") {
    return { kind: "purchase-order", id: item.id };
  }
  const entity = SEARCH_TYPE_TO_ENTITY[item.type];
  return { kind: "entity", entity, id: item.id };
}

/**
 * List surface for an entity — the "Back to list" target (§38).
 * Prompt 35 (§39): CRM entities have no bare list route — their lists live
 * in the CRM module tabs (#/crm?tab=leads | #/crm?tab=opportunities).
 */
export function entityListView(entity: EntityType): AppView {
  const crmTab = CRM_ENTITY_TAB[entity as keyof typeof CRM_ENTITY_TAB];
  if (crmTab) {
    return { kind: "crm", tab: crmTab as "leads" | "opportunities" };
  }
  return { kind: "module", module: ENTITY_ROUTES[entity].segment };
}

/** Navigate to an entity detail (pushes a history entry). */
export function navigateToEntity(entity: EntityType, id: string) {
  useAppStore.getState().navigate(entityView(entity, id));
}

/** Navigate back to the entity's list module (§38 — not history-dependent). */
export function navigateToEntityList(entity: EntityType) {
  useAppStore.getState().navigate(entityListView(entity));
}

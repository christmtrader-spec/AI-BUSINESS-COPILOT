/**
 * Prompt 34 — pure query-key factory (§35).
 * Kept import-free so unit tests (scripts/prompt34-unit.ts) can verify
 * business/entity isolation without pulling in client-only modules.
 */

import type { EntityType } from "@/lib/entity-routes";

export const entityKeys = {
  all: ["entities"] as const,
  business: (businessId: string) => ["entities", businessId] as const,
  one: (businessId: string | null | undefined, entity: EntityType, id: string) =>
    ["entities", businessId ?? "none", entity, id] as const,
};

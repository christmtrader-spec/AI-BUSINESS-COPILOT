"use client";

/**
 * Prompt 36 — tenant-safe context option lists (§57/§77/§78).
 *
 * Used by the activity/task forms to anchor a new record to an entity of
 * the CURRENT business. Server always re-validates the exact id (§70);
 * these lists are convenience only. Options carry id/name pairs and are
 * loaded once per mount in a useEffect — render phase stays pure.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export type ContextOption = { id: string; name: string };

function useOptions(url: string, enabled: boolean): ContextOption[] {
  const [options, setOptions] = useState<ContextOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api<{ items: ContextOption[] }>(url)
      .then((res) => {
        if (!cancelled) setOptions(res.items);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, url]);
  return options;
}

export function useCustomerOptions(enabled = true) {
  return useOptions("/api/v1/customers?pageSize=100", enabled);
}

export function useLeadOptions(enabled = true) {
  return useOptions("/api/v1/crm/leads?pageSize=100", enabled);
}

export function useOpportunityOptions(enabled = true) {
  return useOptions("/api/v1/crm/opportunities?pageSize=100", enabled);
}

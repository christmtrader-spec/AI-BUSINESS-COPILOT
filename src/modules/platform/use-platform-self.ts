"use client";

/**
 * Operator capability probe — Prompt 28 §16.
 *
 * ONE cheap /platform/self call per authenticated session decides whether
 * the platform console exists for this user. Tenants get 403 → null → no
 * platform navigation is rendered and NO platform data API is ever fetched
 * (prefetch ban). The probe is cached for the session and retried never —
 * authorization is re-verified by every platform API server-side anyway.
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { platformApi, type PlatformSelf } from "./platform-api";

export function usePlatformSelf(authenticated: boolean) {
  return useQuery<PlatformSelf | null>({
    queryKey: ["platform", "self"],
    queryFn: async () => {
      try {
        return await platformApi<PlatformSelf>("/api/v1/platform/self");
      } catch (error) {
        if (error instanceof Error && "status" in error && (error as { status: number }).status === 403) {
          return null; // plain tenant user — the honest, expected answer
        }
        throw error;
      }
    },
    enabled: authenticated,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

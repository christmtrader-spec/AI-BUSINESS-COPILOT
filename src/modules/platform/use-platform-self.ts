"use client";

/**
 * Operator capability probe — Prompt 28 §16.
 *
 * ONE cheap /platform/self call per authenticated session decides whether
 * the platform console exists for this user. Tenants get 403 → null → no
 * platform navigation is rendered and NO platform data API is ever fetched
 * (prefetch ban). The probe is cached for the session and retried never —
 * authorization is re-verified by every platform API server-side anyway.
 *
 * R65 (§6.2 fail-closed): an operator whose account lacks mandatory MFA now
 * ALSO gets a 403 — but with the distinct PLATFORM_MFA_REQUIRED code. The
 * probe surfaces that as the "mfa-required" sentinel so PlatformRoot can
 * offer the enrollment path instead of the generic no-access card. Plain
 * tenants still get null.
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { ApiClientError } from "@/lib/api-client";
import { platformApi, type PlatformSelf } from "./platform-api";

/** Union result of the capability probe. */
export type PlatformSelfResult = PlatformSelf | "mfa-required" | null;

/** Type guard — narrows the probe result to a real operator profile. */
export function isPlatformSelf(value: PlatformSelfResult | undefined): value is PlatformSelf {
  return typeof value === "object" && value !== null && value.isOperator === true;
}

export function usePlatformSelf(authenticated: boolean) {
  return useQuery<PlatformSelfResult>({
    queryKey: ["platform", "self"],
    queryFn: async () => {
      try {
        return await platformApi<PlatformSelf>("/api/v1/platform/self");
      } catch (error) {
        // R65 — fail-closed MFA policy for operators: distinguishable from a
        // plain tenant's 403 so the UI can offer enrollment (§6.2).
        if (error instanceof ApiClientError && error.code === "PLATFORM_MFA_REQUIRED") {
          return "mfa-required";
        }
        if (error instanceof ApiClientError && error.status === 403) {
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

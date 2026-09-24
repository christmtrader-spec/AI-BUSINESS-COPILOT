"use client";

/**
 * Localized copy for plan-limit / feature-gate API errors (r21 UX detail).
 *
 * The server's `message` field is API-consumer text (English by design).
 * Showing it verbatim in a fa-RTL toast leaks server language and internal
 * codes like "TEAM_MEMBERS_MAX" into the UI. This hook maps the structured
 * BillingError details (feature code + limit) to honest, localized copy.
 *
 * Bounded by design: only the entitlement codes that actually gate UI flows
 * are mapped; anything unknown falls back to the server message — never a
 * fabricated claim about the user's plan.
 */
import { useTranslations } from "next-intl";

import { ApiClientError } from "@/lib/api-client";

type BillingErrorDetails = {
  feature?: string;
  limit?: number | null;
};

export function useBillingErrorText() {
  const t = useTranslations("errors");

  return (err: unknown): string => {
    if (!(err instanceof ApiClientError)) {
      return t("generic");
    }
    const details = (err.details ?? {}) as BillingErrorDetails;
    switch (err.code) {
      case "ENTITLEMENT_LIMIT_REACHED":
        switch (details.feature) {
          case "TEAM_MEMBERS_MAX":
            return t("planLimitTeamMembers", { limit: details.limit ?? 0 });
          case "CUSTOMERS_MAX":
            return t("planLimitCustomers", { limit: details.limit ?? 0 });
          case "PRODUCTS_MAX":
            return t("planLimitProducts", { limit: details.limit ?? 0 });
          case "BUSINESSES_MAX":
            return t("planLimitBusinesses", { limit: details.limit ?? 0 });
        }
        break;
      case "ENTITLEMENT_NOT_AVAILABLE":
        if (details.feature === "CSV_EXPORT") {
          return t("featureLockedCsv");
        }
        break;
    }
    return err.message;
  };
}

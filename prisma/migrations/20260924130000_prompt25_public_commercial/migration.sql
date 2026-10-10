-- Prompt 25 — public pricing / trial / onboarding / conversion funnel.
-- ADDITIVE ONLY (Constitution): no existing column is altered or dropped,
-- no existing row is rewritten except the documented onboarding backfill.

-- AnalyticsEvent: first-party conversion events (allowlisted names only).
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "businessId" TEXT,
    "planCode" TEXT,
    "billingPeriod" TEXT,
    "currency" TEXT,
    "page" TEXT,
    "source" TEXT,
    "locale" TEXT,
    "dedupeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AnalyticsEvent_dedupeKey_key" ON "AnalyticsEvent"("dedupeKey");
CREATE INDEX "AnalyticsEvent_name_createdAt_idx" ON "AnalyticsEvent"("name", "createdAt");
CREATE INDEX "AnalyticsEvent_businessId_idx" ON "AnalyticsEvent"("businessId");

-- ContactLead: minimal contact-sales capture (name/email/company/message).
CREATE TABLE "ContactLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "message" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Business: server-authoritative onboarding state (§45).
ALTER TABLE "Business" ADD COLUMN "onboardingCompletedAt" DATETIME;
ALTER TABLE "Business" ADD COLUMN "onboardingDismissedAt" DATETIME;

-- Backfill (documented in docs/marketing/onboarding.md): every business
-- that existed BEFORE Prompt 25 is marked onboarding-complete so the new
-- flow NEVER retroactively forces itself on existing tenants. New
-- businesses start with NULL and go through onboarding.
UPDATE "Business"
SET "onboardingCompletedAt" = "createdAt"
WHERE "onboardingCompletedAt" IS NULL
  AND "onboardingDismissedAt" IS NULL;

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN "initiatedByUserId" TEXT;
ALTER TABLE "CheckoutSession" ADD COLUMN "pricingVersion" TEXT;
ALTER TABLE "CheckoutSession" ADD COLUMN "reconciliationReason" TEXT;

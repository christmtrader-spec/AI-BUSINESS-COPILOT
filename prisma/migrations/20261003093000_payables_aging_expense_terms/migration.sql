/*
 Payables aging + supplier-bill enrichment (additive only — zero drops).
 - Expense.dueDate: date-only supplier-bill due date (§84 UTC-midnoon rule).
 - Expense.reference: free-text supplier bill/invoice reference (≤ 80).
 - Composite index supports due-date ordered scans per business.
*/
-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "dueDate" DATETIME;
ALTER TABLE "Expense" ADD COLUMN "reference" TEXT;

-- CreateIndex
CREATE INDEX "Expense_businessId_dueDate_idx" ON "Expense"("businessId", "dueDate");

-- Prompt 37 — CRM Task Reminders (§160/§161).
-- Purely ADDITIVE: 3 new columns on CrmTask. No DROP, no rename, no
-- financial table rewrite, no data conversion, no backfill. Existing tasks
-- keep reminderEnabled=false / reminderMinutesBefore=null /
-- overdueAlertEnabled=false → notification-free (§160).

-- AlterTable
ALTER TABLE "CrmTask" ADD COLUMN "reminderEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CrmTask" ADD COLUMN "reminderMinutesBefore" INTEGER;
ALTER TABLE "CrmTask" ADD COLUMN "overdueAlertEnabled" BOOLEAN NOT NULL DEFAULT false;

-- R108 — server-persisted getting-started checklist dismissal (§406 law:
-- UI state that must survive devices lives on the server, never localStorage).
-- NULL = visible; non-null = dismissed. Reversible (restore clears it).
ALTER TABLE "User" ADD COLUMN "checklistDismissedAt" DATETIME;

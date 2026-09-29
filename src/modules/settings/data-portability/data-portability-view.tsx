"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Info, ShieldAlert } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { ExportPanel } from "./export-panel";
import { ImportPanel } from "./import-panel";
import { TemplatesPanel } from "./templates-panel";

/**
 * Data Portability center — Prompt 31 §123/§129/§130/§185-§189/§333/§334.
 *
 * Placement law (§186/§187/§188): exports/imports belong to BUSINESS data,
 * so the center lives at #/data (Business Settings family) — NOT inside the
 * Security Center, NOT inside Billing, and it never exposes provider cost.
 */
export function DataPortabilityView({ role }: { role: Role }) {
  const t = useTranslations("portability");
  const canManage = can(role, "settings:manage") && (role === "OWNER" || role === "ADMIN");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
      </header>

      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start">
          <Info className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <div className="space-y-1 text-sm">
            <p>{t("education")}</p>
            <p className="text-muted-foreground">{t("backupNote")}</p>
          </div>
        </CardContent>
      </Card>

      {!canManage ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>{t("roleNote")}</span>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="exports" className="w-full">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="exports">{t("tabs.exports")}</TabsTrigger>
          <TabsTrigger value="imports" disabled={!canManage}>
            {t("tabs.imports")}
          </TabsTrigger>
          <TabsTrigger value="templates">{t("tabs.templates")}</TabsTrigger>
        </TabsList>
        <TabsContent value="exports" className="mt-4">
          <ExportPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="imports" className="mt-4">
          {canManage ? <ImportPanel /> : null}
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

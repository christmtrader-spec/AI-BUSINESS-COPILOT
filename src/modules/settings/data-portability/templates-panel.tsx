"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, FileSpreadsheet, Loader2 } from "lucide-react";

const TEMPLATES = [
  { dataset: "customers", file: "Customer.csv", labelKey: "templateCustomer" },
  { dataset: "suppliers", file: "Supplier.csv", labelKey: "templateSupplier" },
  { dataset: "products", file: "Product.csv", labelKey: "templateProduct" },
] as const;

/**
 * Import templates — Prompt 31 §119-§120/§211-§213. Stable machine headers,
 * one synthetic example row; the template our app generates is always
 * accepted by our importer (verified by the Prompt 31 harness).
 */
export function TemplatesPanel() {
  const t = useTranslations("portability");
  const [busy, setBusy] = useState<string | null>(null);

  async function download(dataset: string, file: string) {
    setBusy(dataset);
    try {
      const res = await fetch(`/api/v1/imports/templates/${dataset}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("downloadFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("templatesTitle")}</CardTitle>
        <CardDescription>{t("templatesDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {TEMPLATES.map((tpl) => (
            <div key={tpl.dataset} className="flex flex-col justify-between gap-3 rounded-lg border p-4">
              <div className="flex items-start gap-2">
                <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t(tpl.labelKey)}</p>
                  <p className="text-muted-foreground mt-0.5 font-mono text-xs">{tpl.file}</p>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => download(tpl.dataset, tpl.file)} disabled={busy === tpl.dataset}>
                {busy === tpl.dataset ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                {t("download")}
              </Button>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">{t("templateNote")}</p>
      </CardContent>
    </Card>
  );
}

"use client";

/**
 * Shared public footer — Prompt 27 (§59/§101/§102).
 *
 * One footer for every public page (legal documents + pricing). Legal links
 * are translated through the i18n layer — no hard-coded labels. The cookies
 * link is always shown because the service genuinely uses non-essential
 * cookies and documents them (§47). The footer is layout-sticky: pages keep
 * `min-h-svh flex flex-col` with a `flex-1` main so it sits at the viewport
 * bottom on short pages and is pushed down naturally on long ones.
 */

import { useTranslations } from "next-intl";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export type PublicFooterProps = {
  /** Notes rendered above the legal links (pricing honesty lines). */
  notes?: string[];
  /** Operator name when configured — otherwise nothing is invented. */
  companyName?: string | null;
};

export function PublicFooter({ notes, companyName }: PublicFooterProps) {
  const t = useTranslations("legal.footer");
  const tCommon = useTranslations("common");

  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto w-full max-w-4xl px-4 py-8 text-xs">
        {notes && notes.length > 0 ? (
          <div className="space-y-1.5">
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : null}
        {notes && notes.length > 0 ? <Separator className="my-4" /> : null}
        <nav aria-label={t("ariaLabel")}>
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <li>
              <Link href="/privacy" className="hover:text-foreground underline-offset-4 hover:underline">
                {t("privacy")}
              </Link>
            </li>
            <li>
              <Link href="/terms" className="hover:text-foreground underline-offset-4 hover:underline">
                {t("terms")}
              </Link>
            </li>
            <li>
              <Link href="/ai-data-use" className="hover:text-foreground underline-offset-4 hover:underline">
                {t("aiDataUse")}
              </Link>
            </li>
            <li>
              <Link href="/cookies" className="hover:text-foreground underline-offset-4 hover:underline">
                {t("cookies")}
              </Link>
            </li>
          </ul>
        </nav>
        <p className="mt-3 flex items-center gap-1.5">
          <Sparkles className="size-3.5" aria-hidden="true" />
          {companyName ? companyName : tCommon("appName")}
          {" · "}
          {t("transparencyNote")}
        </p>
      </div>
    </footer>
  );
}

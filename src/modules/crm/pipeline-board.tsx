"use client";

/**
 * Prompt 35 — pipeline board (§54/§55/§96).
 *
 * Six FIXED stage columns (code-defined vocabulary, §7). Each OPEN column
 * shows count + Σ expected value (forecast). Cards are real buttons
 * (keyboard accessible, §95) that open the lead/opportunity detail. Stage
 * change happens through the EXPLICIT Move Stage dialog — drag-and-drop is
 * deliberately NOT faked (§54: no new dependency, keyboard alternative
 * required → we ship the accessible control).
 *
 * Responsive (§96): desktop shows the six columns side by side; below md
 * the board becomes an INTENTIONAL horizontal scroll area (min column
 * width) — six columns are never squeezed into 360px.
 */

import { useTranslations } from "next-intl";
import { CalendarClock, UserRound } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BusinessSummary } from "../shell/types";
import type { CrmOpportunityRef } from "@/lib/crm";
import { stageCategory } from "@/lib/crm/types";
import { EmptyColumnHint, StageBadge, StageColumnHeading } from "./crm-badges";
import { fmtDate, fmtMoney } from "../finance-shared/finance-kit";

export type PipelineStageColumn = {
  stage: CrmOpportunityRef["stage"];
  items: CrmOpportunityRef[];
  totalValueMinor: number;
};

/** Localized, keyboard-navigable stage label (never raw tokens, §59). */
function useStageLabelMap() {
  const tStage = useTranslations("crm.opportunity.stage");
  return (stage: CrmOpportunityRef["stage"]) =>
    ({
      DISCOVERY: tStage("DISCOVERY"),
      QUALIFIED: tStage("QUALIFIED"),
      PROPOSAL: tStage("PROPOSAL"),
      NEGOTIATION: tStage("NEGOTIATION"),
      WON: tStage("WON"),
      LOST: tStage("LOST"),
    })[stage];
}

export function PipelineBoard({
  business,
  columns,
  onOpen,
  loading = false,
}: {
  business: BusinessSummary;
  columns: PipelineStageColumn[];
  onOpen: (id: string) => void;
  loading?: boolean;
}) {
  const t = useTranslations("crm.pipeline");
  const stageLabel = useStageLabelMap();

  return (
    <div
      className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:overflow-visible md:px-0"
      role="region"
      aria-label={t("board")}
    >
      <div className="flex min-w-max gap-3 md:min-w-0 md:grid md:grid-cols-6">
        {columns.map((col) => {
          const open = stageCategory(col.stage) === "OPEN";
          return (
            <section
              key={col.stage}
              aria-label={stageLabel(col.stage)}
              className={cn(
                "bg-muted/30 flex w-64 shrink-0 flex-col gap-2 rounded-xl border p-3 md:w-auto md:shrink",
                col.stage === "WON" && "bg-emerald-500/5",
                col.stage === "LOST" && "bg-zinc-500/5",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <StageColumnHeading stage={col.stage} />
                <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                  {open && col.totalValueMinor > 0 ? fmtMoney(business, col.totalValueMinor) : null}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("columnCount", { count: col.items.length })}
              </p>

              <div className="flex flex-col gap-2">
                {loading ? (
                  <div className="bg-muted-foreground/10 h-16 animate-pulse rounded-md" />
                ) : col.items.length === 0 ? (
                  <EmptyColumnHint label={t("emptyColumn")} />
                ) : (
                  col.items.map((opp) => (
                    <Card
                      key={opp.id}
                      className="p-0 shadow-xs transition-shadow hover:shadow-md motion-reduce:transition-none"
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(opp.id)}
                        className="w-full cursor-pointer rounded-xl p-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={opp.title}
                      >
                        <div className="flex flex-col gap-2">
                          <span className="line-clamp-2 text-sm font-medium">{opp.title}</span>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span dir="ltr" className="tabular-nums font-medium text-foreground">
                              {fmtMoney(business, opp.expectedValueMinor)}
                            </span>
                            <span dir="ltr" className="tabular-nums">
                              {opp.probabilityPct}%
                            </span>
                          </div>
                          {opp.expectedCloseDate ? (
                            <span className="text-muted-foreground flex items-center gap-1 text-xs">
                              <CalendarClock className="size-3" aria-hidden="true" />
                              {fmtDate(business, opp.expectedCloseDate)}
                            </span>
                          ) : null}
                          <StageBadge stage={opp.stage} />
                        </div>
                      </button>
                    </Card>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

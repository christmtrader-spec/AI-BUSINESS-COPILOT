"use client";

/**
 * Prompt 45 — linked dispatch dialog (§79/§80/§81/§82).
 *
 * ONE flow over the order's remaining quantities: create the linked DRAFT
 * GoodsDispatch (§40), then add one order line at a time (salesOrderLineId
 * + qty ONLY — the product/reason derive from the order, §41), then post
 * with the §82 confirmation (posting reduces inventory; NO invoice or
 * payment is created). Draft/cancelled dispatches never count toward
 * fulfillment — the summary numbers come from the order detail.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, Plus } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { SalesOrderDetail } from "./sales-orders-api";
import {
  addLinkedDispatchLine,
  createLinkedDispatch,
  postLinkedDispatch,
} from "./sales-orders-api";
import { goodsDispatchKeys } from "@/modules/inventory/goods-dispatches/goods-dispatches-api";

type StagedLine = {
  salesOrderLineId: string;
  productNameAtOrder: string;
  skuAtOrder: string | null;
  unitAtOrder: string | null;
  orderedQty: number;
  dispatchedQty: number;
  remainingToDispatchQty: number;
  qty: number;
};

export function SalesOrderDispatchDialog({
  order,
  onClose,
}: {
  order: SalesOrderDetail;
  onClose: () => void;
}) {
  const t = useTranslations("salesOrders");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tDispatch = useTranslations("goodsDispatches");
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const queryClient = useQueryClient();

  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [dispatchReference, setDispatchReference] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedLine[]>([]);
  const [qtyTarget, setQtyTarget] = useState<StagedLine | null>(null);
  const [qtyText, setQtyText] = useState("");
  const [postOpen, setPostOpen] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  const dispatchableLines = order.lines.filter((l) => l.remainingToDispatchQty > 0);

  const createDraft = useMutation({
    mutationFn: () => createLinkedDispatch(businessId, order.order.id, { notes: null }),
    onSuccess: (created) => {
      setDispatchId(created.id);
      setDispatchReference(created.reference);
      toast({ description: t("dispatchCreatedToast", { reference: created.reference }) });
    },
    onError: (error) => setDomainError(errorText(error, tErrors("generic"))),
  });

  const addLine = useMutation({
    mutationFn: (input: { salesOrderLineId: string; qty: number }) =>
      addLinkedDispatchLine(businessId, dispatchId as string, input),
    onSuccess: async (_data, input) => {
      setStaged((prev) =>
        prev.map((s) => (s.salesOrderLineId === input.salesOrderLineId ? { ...s, qty: input.qty } : s)),
      );
      setQtyTarget(null);
      toast({ description: t("lineAddedToast") });
      await queryClient.invalidateQueries({ queryKey: goodsDispatchKeys.all });
    },
    onError: (error) => setDomainError(errorText(error, tErrors("generic"))),
  });

  const post = useMutation({
    mutationFn: () => postLinkedDispatch(businessId, dispatchId as string),
    onSuccess: async () => {
      toast({ description: tDispatch("postToast") });
      setPostOpen(false);
      // Refresh everything the posted dispatch touches: stock, order
      // fulfillment, dispatch history and the entity widgets.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sales-orders"] }),
        queryClient.invalidateQueries({ queryKey: goodsDispatchKeys.all }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["adjustments"] }),
        queryClient.invalidateQueries({ queryKey: ["entities", businessId] }),
      ]);
      onClose();
    },
    onError: (error) => {
      setPostOpen(false);
      setDomainError(errorText(error, tErrors("generic")));
    },
  });

  function errorText(error: unknown, fallback: string): string {
    if (error instanceof ApiClientError) {
      if (error.code === "SALES_ORDER_DISPATCH_EXCEEDS_REMAINING") return t("dispatchExceedsRemaining");
      if (error.code === "SALES_ORDER_INVALID_STATUS") return t("invalidStatus");
      if (error.code === "GOODS_DISPATCH_INSUFFICIENT_STOCK") return t("invoiceIssueFailed");
    }
    return fallback;
  }

  function stageLine(line: SalesOrderDetail["lines"][number]) {
    setQtyTarget({
      salesOrderLineId: line.id,
      productNameAtOrder: line.productNameAtOrder,
      skuAtOrder: line.skuAtOrder,
      unitAtOrder: line.unitAtOrder,
      orderedQty: line.orderedQty,
      dispatchedQty: line.dispatchedQty,
      remainingToDispatchQty: line.remainingToDispatchQty,
      qty: 1,
    });
    setQtyText(String(line.remainingToDispatchQty));
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="sales-order-dispatch-dialog">
          <DialogHeader>
            <DialogTitle>{t("dispatchDialogTitle")}</DialogTitle>
            <DialogDescription>{t("recordDispatchDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!dispatchId ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground" data-testid="dispatch-no-draft">
                  {t("recordDispatchTitle")}
                </p>
                {domainError ? <p className="text-destructive text-sm" role="alert">{domainError}</p> : null}
                <Button type="button" onClick={() => createDraft.mutate()} disabled={createDraft.isPending}>
                  {createDraft.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  <Plus className="size-4" aria-hidden />
                  {t("recordDispatch")}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs" dir="auto">
                    {dispatchReference}
                  </Badge>
                  <span className="text-muted-foreground text-xs">{t("lines")}</span>
                </div>

                <div className="space-y-1.5">
                  <Label>{t("dispatchPickLines")}</Label>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-2">
                    {dispatchableLines.length === 0 ? (
                      <p className="text-muted-foreground py-4 text-center text-sm">{t("dispatchNoRemaining")}</p>
                    ) : (
                      dispatchableLines.map((line) => {
                        const stagedLine = staged.find((s) => s.salesOrderLineId === line.id);
                        return (
                          <div
                            key={line.id}
                            className="flex items-center justify-between gap-2 rounded-md border px-2 py-2"
                            data-testid={`dispatch-line-${line.id}`}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium" dir="auto">
                                {line.productNameAtOrder}
                                {line.skuAtOrder ? <span className="text-muted-foreground font-normal"> · {line.skuAtOrder}</span> : null}
                              </p>
                              <p className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                                {t("dispatchOrdered")}: {line.orderedQty} · {t("dispatchAlreadyDispatched")}: {line.dispatchedQty} · {t("dispatchRemaining")}: {line.remainingToDispatchQty}
                              </p>
                            </div>
                            {stagedLine ? (
                              <span className="text-sm font-medium tabular-nums" dir="ltr">+{stagedLine.qty}</span>
                            ) : (
                              <Button type="button" size="sm" variant="outline" onClick={() => stageLine(line)}>
                                <Plus className="size-3.5" aria-hidden />
                              </Button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {domainError ? <p className="text-destructive text-sm" role="alert">{domainError}</p> : null}

                <p className="text-muted-foreground text-xs">{t("postDispatchNote")}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              disabled={!dispatchId || staged.length === 0}
              onClick={() => setPostOpen(true)}
            >
              {t("recordDispatch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Qty dialog for ONE order line (advisory remaining bound §42). */}
      {qtyTarget ? (
        <Dialog open onOpenChange={(open) => !open && setQtyTarget(null)}>
          <DialogContent className="sm:max-w-sm" data-testid="sales-order-dispatch-qty-dialog">
            <DialogHeader>
              <DialogTitle>{t("dispatchQtyLabel")}</DialogTitle>
              <DialogDescription>
                {qtyTarget.productNameAtOrder}
                {qtyTarget.skuAtOrder ? ` · ${qtyTarget.skuAtOrder}` : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="dispatch-qty">{t("dispatchQtyLabel")}</Label>
                <Input
                  id="dispatch-qty"
                  type="number"
                  min={1}
                  max={qtyTarget.remainingToDispatchQty}
                  step={1}
                  value={qtyText}
                  onChange={(e) => setQtyText(e.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                />
              </div>
              {domainError ? <p className="text-destructive text-sm" role="alert">{domainError}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setQtyTarget(null)}>
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                disabled={
                  addLine.isPending ||
                  !Number.isSafeInteger(Number(qtyText)) ||
                  Number(qtyText) < 1 ||
                  Number(qtyText) > qtyTarget.remainingToDispatchQty
                }
                onClick={() => {
                  setDomainError(null);
                  setStaged((prev) => [
                    ...prev.filter((s) => s.salesOrderLineId !== qtyTarget.salesOrderLineId),
                    { ...qtyTarget, qty: Number(qtyText) },
                  ]);
                  addLine.mutate({
                    salesOrderLineId: qtyTarget.salesOrderLineId,
                    qty: Number(qtyText),
                  });
                }}
              >
                {addLine.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {tCommon("save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* §82 — post confirmation: inventory consequence + financial purity. */}
      <AlertDialog open={postOpen} onOpenChange={setPostOpen}>
        <AlertDialogContent data-testid="sales-order-dispatch-post-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("recordDispatchTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("postDispatchNote")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                post.mutate();
              }}
            >
              {post.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("recordDispatch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

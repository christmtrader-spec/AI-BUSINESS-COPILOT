"use client";

/**
 * Prompt 43 — goods-return detail view (§89/§95/§97/§98).
 *
 * STATUS ACTION VISIBILITY: DRAFT → edit header/lines + Post + Cancel;
 * POSTED → Export + copy link ONLY (§97 — no destructive controls);
 * CANCELLED → Export + copy link ONLY (§98). The server re-validates
 * every mutation anyway.
 *
 * §95 — the post confirmation states the inventory consequence verbatim:
 * "Posting this return will decrease current inventory and cannot be
 * edited or cancelled afterward." + the §147 financial note ("Financial
 * balances are not changed by this document"). No refund/credit-note
 * wording anywhere (§96).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  Download,
  Link2,
  Loader2,
  PackageMinus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { can, type Role } from "@/lib/rbac";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import type { GoodsReturnDetailDto, GoodsReturnLineDto } from "@/lib/inventory/goods-return/dto";
import type { GoodsReturnStatus } from "@/lib/inventory/goods-return/types";
import type { GoodsReceiptDetailDto } from "@/lib/inventory/goods-receipt/dto";
import { fetchGoodsReceipt } from "../goods-receipts/goods-receipts-api";
import {
  addGoodsReturnLine,
  cancelGoodsReturn,
  fetchGoodsReturn,
  goodsReturnKeys,
  postGoodsReturn,
  removeGoodsReturnLine,
  updateGoodsReturnDraft,
  updateGoodsReturnLine,
} from "./goods-returns-api";
import { GoodsReturnLinePicker } from "./goods-return-line-picker";
import {
  GoodsReturnLineDialog,
  type GoodsReturnLineDialogValue,
  type ReturnableReceiptLine,
} from "./goods-return-line-dialog";

function statusBadge(status: GoodsReturnStatus, label: string) {
  const styles: Record<GoodsReturnStatus, string> = {
    DRAFT: "bg-muted text-muted-foreground border-border",
    POSTED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
  };
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", styles[status])}>
      {label}
    </Badge>
  );
}

/** The receipt-detail response carries the ADDITIVE Prompt 43 facts. */
type ReceiptDetailWithReturns = GoodsReceiptDetailDto & {
  returns?: {
    returnable: boolean;
    lines: Array<{
      goodsReceiptLineId: string;
      receivedQty: number;
      returnedQty: number;
      returnableQty: number;
    }>;
    recent: Array<{ id: string; reference: string; status: string; postedAt: string | null; totalReturnedQty: number }>;
  };
};

export function GoodsReturnDetailView({ id, role }: { id: string; role: Role }) {
  const t = useTranslations("goodsReturns");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const queryClient = useQueryClient();
  const writable = can(role, "data:write");

  const detail = useQuery({
    queryKey: goodsReturnKeys.detail(businessId, id),
    queryFn: () => fetchGoodsReturn(businessId, id),
    retry: false,
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<ReturnableReceiptLine | null>(null);
  const [editTarget, setEditTarget] = useState<{ line: GoodsReturnLineDto } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<GoodsReturnLineDto | null>(null);
  const [postOpen, setPostOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [editHeaderOpen, setEditHeaderOpen] = useState(false);
  const [headerReference, setHeaderReference] = useState("");
  const [headerNotes, setHeaderNotes] = useState("");
  const [postConflict, setPostConflict] = useState(false);

  const data = detail.data;
  const isDraft = data?.status === "DRAFT";

  // §93 — the picker needs the SOURCE receipt's return facts (which lines
  // still have returnableQty > 0) merged with its line snapshots. Fetched
  // for the picker AND the edit dialog (current facts).
  const receipt = useQuery({
    queryKey: ["goods-receipts", "detail", businessId, data?.goodsReceipt.id],
    queryFn: () => fetchGoodsReceipt(businessId, data!.goodsReceipt.id) as Promise<ReceiptDetailWithReturns>,
    enabled: isDraft && (pickerOpen || editTarget !== null) && !!data?.goodsReceipt.id,
  });

  const returnableLines: ReturnableReceiptLine[] = useMemo(() => {
    const r = receipt.data;
    if (!r?.returns) return [];
    const byId = new Map(r.lines.map((l) => [l.id, l]));
    return r.returns.lines
      .map((facts) => {
        const line = byId.get(facts.goodsReceiptLineId);
        if (!line) return null;
        return {
          id: facts.goodsReceiptLineId,
          productId: line.productId,
          productNameAtReceipt: line.productNameAtReceipt,
          skuAtReceipt: line.skuAtReceipt,
          unitAtReceipt: line.unitAtReceipt,
          receivedQty: facts.receivedQty,
          returnedQty: facts.returnedQty,
          returnableQty: facts.returnableQty,
        } satisfies ReturnableReceiptLine;
      })
      .filter((l): l is ReturnableReceiptLine => l !== null && l.returnableQty > 0);
  }, [receipt.data]);

  const invalidateAll = async () => {
    // §148 — refresh the return, its source receipt, the PO, inventory
    // products and the adjustment feed after any posting-affecting change.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: goodsReturnKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] }),
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] }),
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["adjustments"] }),
      queryClient.invalidateQueries({ queryKey: ["entities", businessId] }),
    ]);
  };

  const addLine = useMutation({
    mutationFn: (input: { goodsReceiptLineId: string; returnedQty: number; reasonCode: string }) =>
      addGoodsReturnLine(businessId, id, input),
    onSuccess: async () => {
      toast({ description: t("lineAddedToast") });
      setAddTarget(null);
      await invalidateAll();
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.code === "GOODS_RETURN_EXCEEDS_RETURNABLE") {
          toast({ title: t("exceedsReturnable"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_LINE_LIMIT_REACHED") {
          toast({ title: t("lineLimit"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_DUPLICATE_LINE" && err.status === 409) {
          toast({ title: t("duplicateLine"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_SOURCE_NOT_POSTED") {
          toast({ title: t("sourceNotPosted"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_IMMUTABLE") {
          toast({ title: t("immutable"), variant: "destructive" });
        } else {
          toast({ title: tErrors("generic"), variant: "destructive" });
        }
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  const updateLine = useMutation({
    mutationFn: (input: { lineId: string; returnedQty: number; reasonCode: string }) =>
      updateGoodsReturnLine(businessId, id, input.lineId, {
        returnedQty: input.returnedQty,
        reasonCode: input.reasonCode,
      }),
    onSuccess: async () => {
      toast({ description: t("lineUpdatedToast") });
      setEditTarget(null);
      await invalidateAll();
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.code === "GOODS_RETURN_EXCEEDS_RETURNABLE") {
        toast({ title: t("exceedsReturnable"), variant: "destructive" });
      } else if (err instanceof ApiClientError && err.code === "GOODS_RETURN_IMMUTABLE") {
        toast({ title: t("immutable"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  const removeLine = useMutation({
    mutationFn: (lineId: string) => removeGoodsReturnLine(businessId, id, lineId),
    onSuccess: async () => {
      toast({ description: t("lineRemovedToast") });
      setRemoveTarget(null);
      await invalidateAll();
    },
    onError: () => toast({ title: tErrors("generic"), variant: "destructive" }),
  });

  const post = useMutation({
    mutationFn: () => postGoodsReturn(businessId, id),
    onSuccess: async () => {
      toast({ description: t("postToast") });
      setPostOpen(false);
      await invalidateAll();
    },
    onError: (err) => {
      setPostOpen(false);
      if (err instanceof ApiClientError) {
        if (err.code === "GOODS_RETURN_EXCEEDS_RETURNABLE") {
          // §63 — localized conflict; NO automatic rebase (the user edits
          // or cancels the stale draft).
          setPostConflict(true);
        } else if (err.code === "GOODS_RETURN_INSUFFICIENT_STOCK") {
          // §39 — current stock check failed.
          toast({ title: t("insufficientStock"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_EMPTY") {
          toast({ title: t("postEmpty"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_SOURCE_NOT_POSTED") {
          toast({ title: t("sourceNotPosted"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_SOURCE_LINE_NOT_FOUND") {
          toast({ title: t("productNotFound"), variant: "destructive" });
        } else if (err.code === "GOODS_RETURN_INVALID_TRANSITION") {
          toast({ title: t("invalidTransition"), variant: "destructive" });
        } else {
          toast({ title: tErrors("generic"), variant: "destructive" });
        }
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelGoodsReturn(businessId, id),
    onSuccess: async () => {
      toast({ description: t("cancelToast") });
      setCancelOpen(false);
      await invalidateAll();
    },
    onError: () => toast({ title: tErrors("generic"), variant: "destructive" }),
  });

  const updateHeader = useMutation({
    mutationFn: (body: { reference?: string; notes?: string | null }) =>
      updateGoodsReturnDraft(businessId, id, body),
    onSuccess: async () => {
      toast({ description: t("updatedToast") });
      setEditHeaderOpen(false);
      await queryClient.invalidateQueries({ queryKey: goodsReturnKeys.all });
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.code === "GOODS_RETURN_DUPLICATE_REFERENCE") {
        toast({ title: t("duplicateReference"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  /** §103-analog — download the CSV through the export endpoint. */
  async function exportCsv() {
    try {
      const res = await fetch(`/api/v1/inventory/goods-returns/${id}/export`, {
        headers: { "x-business-id": businessId },
      });
      if (res.status === 429) {
        toast({ title: t("exportRateLimited"), variant: "destructive" });
        return;
      }
      if (res.status === 403) {
        toast({ title: t("exportForbidden"), variant: "destructive" });
        return;
      }
      if (!res.ok) {
        toast({ title: t("exportFailed"), variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? "goods-return.csv";
      a.click();
      URL.revokeObjectURL(url);
      toast({ description: t("exportToast") });
    } catch {
      toast({ title: t("exportFailed"), variant: "destructive" });
    }
  }

  async function copyLink() {
    const hash = `#/inventory/goods-returns/${id}`;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${hash}`);
      toast({ description: tCommon("copied") });
    } catch {
      toast({ description: hash });
    }
  }

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }), []);

  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (detail.isError || !data) {
    const notFound = detail.error instanceof ApiClientError && detail.error.status === 404;
    return (
      <EmptyState
        icon={PackageMinus}
        title={notFound ? t("notFoundTitle") : tErrors("generic")}
        description={notFound ? t("notFoundDesc") : tCommon("retry")}
        action={
          <Button type="button" variant="outline" onClick={() => navigate({ kind: "inventory-goods-returns" })}>
            <ArrowLeft className="size-4" aria-hidden />
            {t("backToList")}
          </Button>
        }
      />
    );
  }

  const canPost = writable && isDraft && data.lines.length > 0;
  const canCancel = writable && isDraft;
  const canEdit = writable && isDraft;

  return (
    <div className="space-y-6" data-view="inventory-goods-return">
      <PageHeader
        title={data.reference}
        subtitle={t("detailSubtitle", { supplier: data.supplierNameAtReturn })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={copyLink}>
              <Link2 className="size-4" aria-hidden />
              {t("copyLink")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
              <Download className="size-4" aria-hidden />
              {t("exportAction")}
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground text-xs">{t("status")}</p>
            <div className="mt-1">{statusBadge(data.status, t(`status_${data.status}`))}</div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("sourceReceipt")}</p>
            <button
              type="button"
              className="mt-1 font-medium underline-offset-4 hover:underline"
              onClick={() => navigate({ kind: "inventory-goods-receipt", id: data.goodsReceipt.id })}
            >
              {data.goodsReceipt.referenceAtReturn}
            </button>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("supplier")}</p>
            <p className="mt-1 text-sm" dir="auto">{data.supplierNameAtReturn}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("totalReturned")}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
              {data.summary.totalReturnedQty}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("createdAtLabel")}</p>
            <p className="mt-1 text-sm" dir="ltr">{dateFmt.format(new Date(data.createdAt))}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("postedAtLabel")}</p>
            <p className="mt-1 text-sm" dir="ltr">
              {data.postedAt ? dateFmt.format(new Date(data.postedAt)) : "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("createdBy")}</p>
            <p className="mt-1 text-sm">{data.createdBy?.name ?? "—"}</p>
          </div>
          {data.notes ? (
            <div className="sm:col-span-2 lg:col-span-1">
              <p className="text-muted-foreground text-xs">{t("notes")}</p>
              <p className="mt-1 text-sm whitespace-pre-line" dir="auto">{data.notes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {postConflict ? (
        <Card className="border-amber-500/40">
          <CardContent className="flex items-center justify-between gap-3 pt-4">
            <p className="text-sm text-amber-700 dark:text-amber-300">{t("staleReturnable")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setPostConflict(false)}>
              {tCommon("close")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!isDraft ? (
        <p className="text-muted-foreground text-sm">{t("readOnlyNote")}</p>
      ) : (
        <p className="text-muted-foreground text-sm">{t("inventoryNote")}</p>
      )}

      <Card>
        <CardContent className="pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("linesTitle")}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {canEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setHeaderReference(data.reference);
                    setHeaderNotes(data.notes ?? "");
                    setEditHeaderOpen(true);
                  }}
                >
                  <Pencil className="size-4" aria-hidden />
                  {tCommon("edit")}
                </Button>
              ) : null}
              {canEdit ? (
                <Button type="button" size="sm" onClick={() => setPickerOpen(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t("addLine")}
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
                  {t("cancelAction")}
                </Button>
              ) : null}
              {canPost ? (
                <Button type="button" size="sm" onClick={() => setPostOpen(true)}>
                  <Loader2 className={cn("size-4", post.isPending ? "animate-spin" : "hidden")} aria-hidden />
                  {t("postAction")}
                </Button>
              ) : null}
            </div>
          </div>

          {data.lines.length === 0 ? (
            <EmptyState icon={Plus} title={t("noLines")} description={isDraft ? t("addLineSearch") : ""} />
          ) : (
            <DataTable
              columns={[
                {
                  id: "product",
                  header: t("product"),
                  cell: (r: GoodsReturnLineDto) => (
                    <span className="min-w-0">
                      <span className="block truncate font-medium" dir="auto">{r.productNameAtReturn}</span>
                      {r.skuAtReturn ? (
                        <span className="text-muted-foreground block text-xs" dir="auto">{r.skuAtReturn}</span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  id: "unit",
                  header: t("unit"),
                  hideBelow: "md",
                  cell: (r: GoodsReturnLineDto) => (
                    <span className="text-sm" dir="auto">{r.unitAtReturn ?? "—"}</span>
                  ),
                },
                {
                  id: "reason",
                  header: t("reasonLabel"),
                  hideBelow: "md",
                  cell: (r: GoodsReturnLineDto) => (
                    <span className="text-sm">{t(`reason_${r.reasonCode}`)}</span>
                  ),
                },
                {
                  id: "qty",
                  header: t("returnedQty"),
                  align: "end",
                  cell: (r: GoodsReturnLineDto) => (
                    <span className="font-medium tabular-nums" dir="ltr">{r.returnedQty}</span>
                  ),
                },
                ...(canEdit
                  ? [
                      {
                        id: "actions",
                        header: "",
                        align: "end" as const,
                        cell: (r: GoodsReturnLineDto) => (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("editLine")}
                              onClick={() => setEditTarget({ line: r })}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("removeLine")}
                              onClick={() => setRemoveTarget(r)}
                            >
                              <Trash2 className="text-destructive size-4" aria-hidden />
                            </Button>
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
              rows={data.lines}
              getRowId={(r) => r.id}
              ariaLabel={t("linesTitle")}
            />
          )}
        </CardContent>
      </Card>

      {pickerOpen ? (
        <GoodsReturnLinePicker
          lines={returnableLines}
          existingLines={data.lines}
          onPick={(line) => {
            setPickerOpen(false);
            setAddTarget(line);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {addTarget ? (
        <GoodsReturnLineDialog
          line={addTarget}
          title={t("addLineAction")}
          submitLabel={t("addLineAction")}
          cancelLabel={tCommon("cancel")}
          qtyLabel={t("returnedQty")}
          receivedLabel={t("receivedQty")}
          returnedLabel={t("returnedQty")}
          returnableLabel={t("returnableQty")}
          reasonLabel={t("reasonLabel")}
          invalidQtyMessage={t("invalidQty")}
          exceedsMessage={t("exceedsReturnable")}
          onSubmit={(value: GoodsReturnLineDialogValue) =>
            addLine.mutate({
              goodsReceiptLineId: addTarget.id,
              returnedQty: value.returnedQty,
              reasonCode: value.reasonCode,
            })
          }
          onClose={() => setAddTarget(null)}
        />
      ) : null}

      {editTarget ? (() => {
        // §94 — the edit dialog shows the receipt line's CURRENT returnable
        // facts; its own quantity is added back into the allowance.
        const live = returnableLines.find(
          (l) => l.id === editTarget.line.goodsReceiptLineId,
        );
        const dialogLine: ReturnableReceiptLine = live ?? {
          id: editTarget.line.goodsReceiptLineId,
          productId: editTarget.line.productId,
          productNameAtReceipt: editTarget.line.productNameAtReturn,
          skuAtReceipt: editTarget.line.skuAtReturn,
          unitAtReceipt: editTarget.line.unitAtReturn,
          receivedQty: 0,
          returnedQty: 0,
          returnableQty: 0, // fully consumed elsewhere → only keep/reduce
        };
        return (
          <GoodsReturnLineDialog
            line={dialogLine}
            initialQty={editTarget.line.returnedQty}
            initialReason={editTarget.line.reasonCode}
            title={t("editLineTitle")}
            submitLabel={t("saveLine")}
            cancelLabel={tCommon("cancel")}
            qtyLabel={t("returnedQty")}
            receivedLabel={t("receivedQty")}
            returnedLabel={t("returnedQty")}
            returnableLabel={t("returnableQty")}
            reasonLabel={t("reasonLabel")}
            invalidQtyMessage={t("invalidQty")}
            exceedsMessage={t("exceedsReturnable")}
            onSubmit={(value) =>
              updateLine.mutate({
                lineId: editTarget.line.id,
                returnedQty: value.returnedQty,
                reasonCode: value.reasonCode,
              })
            }
            onClose={() => setEditTarget(null)}
          />
        );
      })() : null}

      {removeTarget ? (
        <Dialog open onOpenChange={(open) => !open && setRemoveTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("removeLineTitle")}</DialogTitle>
              <DialogDescription dir="auto">
                {t("removeLineDesc", { product: removeTarget.productNameAtReturn })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => removeLine.mutate(removeTarget.id)}
                disabled={removeLine.isPending}
              >
                {t("removeAction")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* §95/§147 — posting confirmation shows quantities, the estimated
          stock impact, the immutability warning AND the financial note. */}
      {postOpen ? (
        <Dialog open onOpenChange={(open) => !open && setPostOpen(false)}>
          <DialogContent className="sm:max-w-md" data-testid="goods-return-post-dialog">
            <DialogHeader>
              <DialogTitle>{t("postTitle")}</DialogTitle>
              <DialogDescription>{t("postDesc")}</DialogDescription>
            </DialogHeader>
            <div className="text-muted-foreground space-y-1 rounded-lg border p-3 text-sm">
              <p dir="auto">
                <span className="font-medium text-foreground">{t("sourceReceipt")}:</span>{" "}
                {data.goodsReceipt.referenceAtReturn}
              </p>
              <p dir="auto">
                <span className="font-medium text-foreground">{t("supplier")}:</span>{" "}
                {data.supplierNameAtReturn}
              </p>
              <p>
                <span className="font-medium text-foreground">{t("lines")}:</span>{" "}
                <span className="tabular-nums" dir="ltr">{data.lines.length}</span>
              </p>
              <p>
                <span className="font-medium text-foreground">{t("totalReturned")}:</span>{" "}
                <span className="tabular-nums" dir="ltr">{data.summary.totalReturnedQty}</span>
              </p>
              <p>
                <span className="font-medium text-foreground">{t("estimatedStockImpact")}:</span>{" "}
                <span className="tabular-nums text-amber-700 dark:text-amber-300" dir="ltr">
                  −{data.summary.totalReturnedQty}
                </span>
              </p>
            </div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{t("postWarning")}</p>
            <p className="text-muted-foreground text-xs">{t("postFinancialNote")}</p>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setPostOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="button" onClick={() => post.mutate()} disabled={post.isPending}>
                {t("postConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {cancelOpen ? (
        <Dialog open onOpenChange={(open) => !open && setCancelOpen(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("cancelTitle")}</DialogTitle>
              <DialogDescription>{t("cancelDesc")}</DialogDescription>
            </DialogHeader>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{t("cancelTerminalWarning")}</p>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setCancelOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="button" variant="destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {t("cancelConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {editHeaderOpen ? (
        <Dialog open onOpenChange={(open) => !open && setEditHeaderOpen(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("editTitle")}</DialogTitle>
              <DialogDescription>{t("referenceHint")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="grt-edit-reference">{t("reference")}</Label>
                <Input
                  id="grt-edit-reference"
                  value={headerReference}
                  onChange={(e) => setHeaderReference(e.target.value)}
                  maxLength={96}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="grt-edit-notes">{t("notes")}</Label>
                <textarea
                  id="grt-edit-notes"
                  className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                  value={headerNotes}
                  onChange={(e) => setHeaderNotes(e.target.value)}
                  maxLength={2016}
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setEditHeaderOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                onClick={() =>
                  updateHeader.mutate({
                    reference: headerReference.trim() || undefined,
                    notes: headerNotes.trim() || null,
                  })
                }
                disabled={updateHeader.isPending}
              >
                {tCommon("save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

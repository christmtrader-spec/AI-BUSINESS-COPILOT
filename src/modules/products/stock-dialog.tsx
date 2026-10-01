"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import type { Product } from "./products-view";

/**
 * Shared stock adjustment dialog (used by Products and Inventory views).
 * direction: +1 increase / -1 decrease. Server rejects negative stock.
 */
export function StockDialog({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}) {
  const t = useTranslations("inventory");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const [direction, setDirection] = useState<1 | -1>(1);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const qty = Number.parseInt(amount || "0", 10);
  const valid =
    Number.isInteger(qty) && qty > 0 && reason.trim().length > 0 &&
    !(direction === -1 && qty > product.stockQty);

  const mutation = useMutation({
    mutationFn: async () =>
      api(`/api/v1/products/${product.id}/stock`, {
        method: "POST",
        body: JSON.stringify({ delta: direction * qty, reason: reason.trim() }),
      }),
    onSuccess: () => {
      toast({ title: t("updatedToast") });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["adjustments"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      // Prompt 34 §37 — the open product detail must converge immediately.
      invalidateEntityDetail(queryClient, businessId, "product", product.id);
      onClose();
    },
    onError: (err) => {
      toast({
        title:
          err instanceof ApiClientError
            ? err.message
            : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("adjustTitle", { product: product.name })}</DialogTitle>
          <DialogDescription>
            {t("currentStock")}:{" "}
            <span className="text-foreground font-semibold tabular-nums">
              {product.stockQty}
            </span>{" "}
            {product.unit ?? t("units")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) mutation.mutate();
          }}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label>{t("direction")}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={direction === 1 ? "default" : "outline"}
                onClick={() => setDirection(1)}
                className="justify-start"
              >
                <ArrowUp className="size-4 text-emerald-600 rtl:-scale-x-100" aria-hidden="true" />
                {t("increase")}
              </Button>
              <Button
                type="button"
                variant={direction === -1 ? "default" : "outline"}
                onClick={() => setDirection(-1)}
                className="justify-start"
              >
                <ArrowDown className="text-destructive size-4 rtl:-scale-x-100" aria-hidden="true" />
                {t("decrease")}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="st-amount">{t("amount")}</Label>
            <Input
              id="st-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              placeholder={t("amountPlaceholder")}
              dir="ltr"
              inputMode="numeric"
              className="text-end"
            />
            {direction === -1 && qty > product.stockQty ? (
              <p className="text-destructive text-xs" role="alert">{t("insufficient")}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="st-reason">{t("reason")}</Label>
            <Textarea
              id="st-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              rows={2}
              maxLength={200}
              required
            />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowUp
                  className={cn("size-4", direction === -1 && "rotate-180")}
                  aria-hidden="true"
                />
              )}
              {t("adjust")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

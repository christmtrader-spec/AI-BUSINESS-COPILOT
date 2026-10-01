"use client";

/**
 * Prompt 34 — shared destructive-action dialog for entity detail pages
 * (§25/§26/§29/§30). Same AlertDialog pattern + same DELETE endpoints as
 * the lists — it is a shared UI primitive, NOT a second mutation flow.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "lucide-react";

export function EntityDeleteDialog({
  triggerLabel,
  triggerIcon: Icon,
  title,
  description,
  confirmLabel,
  cancelLabel,
  pending,
  onConfirm,
  destructive = true,
}: {
  triggerLabel: string;
  triggerIcon: LucideIcon;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          className={
            destructive
              ? "text-destructive hover:text-destructive hover:bg-destructive/10"
              : undefined
          }
          aria-label={triggerLabel}
        >
          <Icon className="size-4" aria-hidden="true" />
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

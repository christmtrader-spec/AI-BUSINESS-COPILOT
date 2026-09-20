"use client";

import { useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { toMinor } from "@/lib/money";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

/** Debounced search input (300ms). Owns its draft state internally. */
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handle(next: string) {
    setRaw(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next), 300);
  }

  return (
    <div className="relative w-full sm:max-w-xs">
      <Search
        className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        value={raw}
        onChange={(e) => handle(e.target.value)}
        placeholder={placeholder}
        className="ps-9"
        type="search"
      />
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  labels,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  labels?: { prev?: string; next?: string; of?: string };
}) {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-2 pt-3">
      <p className="text-muted-foreground text-xs tabular-nums">
        {from}–{to} {labels?.of ?? "of"} {total}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label={labels?.prev ?? "Previous"}
        >
          <ChevronLeft className="size-4 rtl:rotate-180" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label={labels?.next ?? "Next"}
        >
          <ChevronRight className="size-4 rtl:rotate-180" />
        </Button>
      </div>
    </div>
  );
}

/** Dialog wrapper for create/edit forms with consistent footer. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submitLabel,
  cancelLabel,
  pending,
  disabled,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onSubmit: (e: React.FormEvent) => void;
  submitLabel: string;
  cancelLabel: string;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {children}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button type="submit" disabled={pending || disabled}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Money input (major units in, minor units out — A08).
 * Returns a parse result so callers never do float math themselves.
 */
export function MoneyInput({
  id,
  label,
  symbol,
  value,
  onChange,
  precision,
  invalidMsg,
  hint,
}: {
  id: string;
  label: string;
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  precision: number;
  invalidMsg?: string;
  hint?: string;
}) {
  let valid = true;
  try {
    toMinor(value === "" ? "0" : value, precision);
  } catch {
    valid = false;
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-sm">
          {symbol}
        </span>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          dir="ltr"
          inputMode="decimal"
          className={cn("ps-8 text-end", !valid && "border-destructive focus-visible:ring-destructive")}
          aria-invalid={!valid}
        />
      </div>
      {!valid && invalidMsg ? (
        <p className="text-destructive text-xs" role="alert">{invalidMsg}</p>
      ) : hint ? (
        <p className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
    </div>
  );
}

export function moneyToMinorOrNull(value: string, precision: number): number | null {
  try {
    return toMinor(value === "" ? "0" : value, precision);
  } catch {
    return null;
  }
}

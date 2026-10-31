"use client";

import { useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
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

/** Locale-aware digits (fa gets ۰۱۲۳…, en gets 0123…). */
function localizedDigits(locale: string, n: number): string {
  return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US").format(n);
}

/** Compact page window with ellipses: 1 … 4 5 6 … 12 */
function pageWindow(page: number, pages: number): (number | "ellipsis")[] {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, i) => i + 1);
  }
  const out: (number | "ellipsis")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) out.push("ellipsis");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < pages - 1) out.push("ellipsis");
  out.push(pages);
  return out;
}

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
  // Interface chrome follows the UI locale (not the business data locale) —
  // a Persian-UI user reads "از" and ۰۱۲۳ digits even while managing an
  // English business.
  const uiLocale = useLocale();
  const tCommon = useTranslations("common");
  const ofWord = labels?.of ?? (uiLocale === "fa" ? "از" : "of");
  const num = (n: number) => localizedDigits(uiLocale, n);
  const safePage = Math.min(Math.max(page, 1), pages);

  return (
    <div className="flex flex-col-reverse items-center justify-between gap-3 pt-4 sm:flex-row">
      <p className="text-muted-foreground text-xs tabular-nums">
        {/* LTR spans keep "from–to" and the total visually intact in RTL
            locales — bidi would otherwise scramble the en-dash sequence. */}
        <span dir="ltr">
          {num(from)}–{num(to)}
        </span>{" "}
        {ofWord} <span dir="ltr">{num(total)}</span>
      </p>
      <nav
        aria-label={uiLocale === "fa" ? "صفحه‌بندی" : "Pagination"}
        className="flex items-center gap-1"
      >
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={safePage <= 1}
          onClick={() => onPage(safePage - 1)}
          aria-label={labels?.prev ?? tCommon("previous")}
          title={labels?.prev ?? tCommon("previous")}
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
        <div className="hidden items-center gap-1 sm:flex">
          {pageWindow(safePage, pages).map((p, i) =>
            p === "ellipsis" ? (
              <span
                key={`gap-${i}`}
                className="text-muted-foreground inline-flex size-8 items-center justify-center text-xs"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <Button
                key={p}
                variant={p === safePage ? "default" : "ghost"}
                size="icon"
                className="size-8 text-xs tabular-nums"
                aria-current={p === safePage ? "page" : undefined}
                aria-label={tCommon("goToPage", { page: num(p) })}
                onClick={() => onPage(p)}
                disabled={p === safePage}
              >
                {num(p)}
              </Button>
            ),
          )}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={safePage >= pages}
          onClick={() => onPage(safePage + 1)}
          aria-label={labels?.next ?? tCommon("next")}
          title={labels?.next ?? tCommon("next")}
        >
          <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
      </nav>
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
          className={cn("text-end ltr:pl-10 rtl:pr-10", !valid && "border-destructive focus-visible:ring-destructive")}
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

"use client";

/**
 * ContactSalesDialog — Prompt 25 §27/§28/§29.
 *
 * The minimal contact-sales capture for ENTERPRISE (and for paid plans when
 * payments are unavailable). Deliberately tiny: name, email, optional
 * company, message — nothing else is collected (§28/§107). Success is a
 * generic reassurance; the server never leaks whether/how leads are stored.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Loader2, MailCheck, Send } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ContactSalesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("contact");
  const { data: session } = useSession();
  const locale = useAppStore((s) => s.locale);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Prefill from the viewer's own session (their data, never anyone else's).
  function prefillFromSession() {
    const u = session?.user as { name?: string | null; email?: string | null } | undefined;
    if (u?.name && !name) setName(u.name);
    if (u?.email && !email) setEmail(u.email);
  }

  const send = useMutation({
    mutationFn: async () =>
      api<{ received: boolean }>("/api/v1/public/contact", {
        method: "POST",
        businessId: null,
        body: JSON.stringify({ name, email, company: company || null, message, locale }),
      }),
    onSuccess: () => {
      setError(null);
      setSent(true);
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.status === 0) setError(t("error"));
        else if (err.code === "RATE_LIMITED") setError(t("errorRateLimited"));
        else setError(t("error"));
      } else {
        setError(t("error"));
      }
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    send.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) prefillFromSession();
        if (!o) setSent(false);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md" data-view="contact-sales">
        <DialogHeader className="space-y-1.5">
          <DialogTitle className="text-xl">{sent ? t("successTitle") : t("title")}</DialogTitle>
          {!sent ? <DialogDescription>{t("subtitle")}</DialogDescription> : null}
        </DialogHeader>

        {sent ? (
          <div className="space-y-5 py-2 text-center">
            <div className="bg-primary/10 mx-auto flex size-12 items-center justify-center rounded-full" aria-hidden="true">
              <MailCheck className="text-primary size-6" />
            </div>
            <p className="text-foreground text-sm" role="status">
              {t("successBody")}
            </p>
          </div>
        ) : (
          <form
            onFocus={prefillFromSession}
            onSubmit={onSubmit}
            className="space-y-4"
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="contact-name">{t("name")}</Label>
                <Input
                  id="contact-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                  maxLength={80}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact-email">{t("email")}</Label>
                <Input
                  id="contact-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  dir="ltr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="contact-company">{t("company")}</Label>
              <Input
                id="contact-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                maxLength={120}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="contact-message">{t("message")}</Label>
              <Textarea
                id="contact-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("messagePlaceholder")}
                rows={4}
                required
                maxLength={2000}
              />
            </div>

            {error ? (
              <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex flex-col gap-3">
              <Button type="submit" className="w-full" disabled={send.isPending}>
                {send.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                {send.isPending ? t("sending") : t("send")}
              </Button>
              <p className="text-muted-foreground text-center text-xs">{t("privacy")}</p>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

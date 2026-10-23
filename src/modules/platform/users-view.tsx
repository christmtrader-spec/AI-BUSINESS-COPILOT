"use client";

/**
 * Platform user search (§21) + session invalidation (§22). The DTO is an
 * explicit allowlist — passwordHash never crosses this UI (§83).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, KeyRound, Megaphone, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformMutations, platformQueries, type PlatformUser } from "./platform-api";
import {
  EmptyState,
  ListSkeleton,
  PaginationBar,
  ReauthDialog,
  formatDateTime,
  usePlatformErrorText,
} from "./kit";
import { isPlatformSelf, usePlatformSelf } from "./use-platform-self";
import { useSession } from "next-auth/react";

const PAGE_SIZE = 20;
/** Mirror of the server cap (§155 — bounded recipients per announcement). */
const ANNOUNCE_RECIPIENT_CAP = 50;
const ANNOUNCE_MESSAGE_MAX = 500;

/** Roles the server admits for announcements (§18 — mirrors the API gate). */
function canAnnounceRole(role: string | undefined): boolean {
  return role === "PLATFORM_SUPER_ADMIN" || role === "PLATFORM_SUPPORT";
}

export function UsersView() {
  const t = useTranslations("platform");
  const { status: sessionStatus } = useSession();
  const self = usePlatformSelf(sessionStatus === "authenticated");
  // R65 — narrow the probe union ("mfa-required" sentinel) to a real profile.
  const selfData = isPlatformSelf(self.data) ? self.data : null;
  const canSuspend = !!selfData?.permissions.includes("platform:users:suspend");
  const canAnnounce = canAnnounceRole(selfData?.role);
  const [email, setEmail] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [invalidateTarget, setInvalidateTarget] = React.useState<PlatformUser | null>(null);
  const [suspendTarget, setSuspendTarget] = React.useState<PlatformUser | null>(null);
  const [reactivateTarget, setReactivateTarget] = React.useState<PlatformUser | null>(null);
  const [announceOpen, setAnnounceOpen] = React.useState(false);

  const params = new URLSearchParams();
  if (email) params.set("email", email);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "users", params.toString()],
    queryFn: () => platformQueries.users(params.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows: PlatformUser[] = data?.users ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="pf-user-email">{t("users.filterEmail")}</Label>
            <Input
              id="pf-user-email"
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setPage(1);
              }}
              placeholder="user@example.com"
            />
          </div>
          {canAnnounce ? (
            <Button variant="outline" onClick={() => setAnnounceOpen(true)}>
              <Megaphone className="size-4" aria-hidden="true" />
              {t("announce.trigger")}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("users.empty")} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("users.email")}</TableHead>
                  <TableHead>{t("users.name")}</TableHead>
                  <TableHead className="text-center">{t("users.owned")}</TableHead>
                  <TableHead className="text-center">{t("users.memberships")}</TableHead>
                  <TableHead>{t("users.sv")}</TableHead>
                  <TableHead>{t("users.operator")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <span dir="ltr" className="text-xs font-medium">
                        {u.email}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{u.name ?? "—"}</TableCell>
                    <TableCell className="text-center tabular-nums">{u.ownedBusinessCount}</TableCell>
                    <TableCell className="text-center tabular-nums">{u.membershipCount}</TableCell>
                    <TableCell className="tabular-nums">{u.sessionVersion}</TableCell>
                    <TableCell>
                      {u.isPlatformOperator ? (
                        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                          {t("users.yes")}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">{t("users.no")}</span>
                      )}
                      {u.suspendedAt ? (
                        <Badge variant="outline" className="ms-1 border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400">
                          {t("users.suspended")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="sm" onClick={() => setInvalidateTarget(u)}>
                          <KeyRound className="size-3.5" aria-hidden="true" />
                          {t("users.invalidate")}
                        </Button>
                        {canSuspend && !u.isPlatformOperator ? (
                          u.suspendedAt ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setReactivateTarget(u)}
                            >
                              <ShieldCheck className="size-3.5" aria-hidden="true" />
                              {t("users.reactivate")}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-400"
                              onClick={() => setSuspendTarget(u)}
                            >
                              <Ban className="size-3.5" aria-hidden="true" />
                              {t("users.suspend")}
                            </Button>
                          )
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 md:hidden">
            {rows.map((u) => (
              <Card key={u.id}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center justify-between">
                    <span dir="ltr" className="text-sm font-medium">
                      {u.email}
                    </span>
                    {u.isPlatformOperator ? (
                      <Badge variant="outline">{t("users.yes")}</Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t("users.owned")} {u.ownedBusinessCount} · {t("users.memberships")}{" "}
                    {u.membershipCount} · sv {u.sessionVersion}
                  </p>
                  <p className="text-muted-foreground text-xs">{formatDateTime(u.createdAt)}</p>
                  <div className="flex flex-wrap gap-1">
                    <Button variant="outline" size="sm" onClick={() => setInvalidateTarget(u)}>
                      <KeyRound className="size-3.5" aria-hidden="true" />
                      {t("users.invalidate")}
                    </Button>
                    {canSuspend && !u.isPlatformOperator ? (
                      u.suspendedAt ? (
                        <Button variant="outline" size="sm" onClick={() => setReactivateTarget(u)}>
                          <ShieldCheck className="size-3.5" aria-hidden="true" />
                          {t("users.reactivate")}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-400"
                          onClick={() => setSuspendTarget(u)}
                        >
                          <Ban className="size-3.5" aria-hidden="true" />
                          {t("users.suspend")}
                        </Button>
                      )
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <PaginationBar
            page={data?.page.page ?? 1}
            hasNext={data?.page.hasNext ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      )}

      <InvalidateDialog target={invalidateTarget} onClose={() => setInvalidateTarget(null)} />
      <SuspendDialog target={suspendTarget} onClose={() => setSuspendTarget(null)} />
      <ReactivateDialog target={reactivateTarget} onClose={() => setReactivateTarget(null)} />
      <AnnounceDialog open={announceOpen} onClose={() => setAnnounceOpen(false)} />
    </div>
  );
}

function InvalidateDialog({ target, onClose }: { target: PlatformUser | null; onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async ({ reason, password }: { reason: string; password: string }) => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.invalidateSessions(target.id, { reason, password });
      toast.success(t("users.invalidateSuccess", { email: target.email }));
      void queryClient.invalidateQueries({ queryKey: ["platform", "users"] });
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ReauthDialog
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      titleKey="dialogs.invalidateTitle"
      descriptionKey="dialogs.invalidateBody"
      values={target ? { email: target.email } : undefined}
      submitting={submitting}
      error={error}
      onSubmit={(p) => void submit({ reason: p.reason, password: p.password })}
    />
  );
}

function SuspendDialog({ target, onClose }: { target: PlatformUser | null; onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async ({ reason, password }: { reason: string; password: string }) => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.suspendUser(target.id, { reason, password });
      toast.success(t("users.suspendSuccess", { email: target.email }));
      void queryClient.invalidateQueries({ queryKey: ["platform", "users"] });
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ReauthDialog
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      titleKey="dialogs.suspendTitle"
      descriptionKey="dialogs.suspendBody"
      values={target ? { email: target.email } : undefined}
      submitting={submitting}
      error={error}
      onSubmit={(p) => void submit({ reason: p.reason, password: p.password })}
    />
  );
}

function ReactivateDialog({ target, onClose }: { target: PlatformUser | null; onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async ({ reason, password }: { reason: string; password: string }) => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await platformMutations.reactivateUser(target.id, { reason, password });
      toast.success(t("users.reactivateSuccess", { email: target.email }));
      void queryClient.invalidateQueries({ queryKey: ["platform", "users"] });
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ReauthDialog
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      titleKey="dialogs.reactivateTitle"
      descriptionKey="dialogs.reactivateBody"
      values={target ? { email: target.email } : undefined}
      submitting={submitting}
      error={error}
      onSubmit={(p) => void submit({ reason: p.reason, password: p.password })}
    />
  );
}

// ---------------------------------------------------------------------------
// Prompt 62 §18 — system-announcement composer. Explicit recipients ONLY
// (never an audience query — §155), capped at 50 like the server, plain
// text message, honest accepted/rejected result surfaced to the operator.
// The dialog body unmounts on close so composer state always resets.
// ---------------------------------------------------------------------------
function AnnounceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("platform");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("announce.title")}</DialogTitle>
          <DialogDescription>{t("announce.description")}</DialogDescription>
        </DialogHeader>
        {open ? <AnnounceForm onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AnnounceForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Array<{ id: string; email: string }>>([]);
  const [message, setMessage] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [validation, setValidation] = React.useState<string | null>(null);

  const listParams = new URLSearchParams();
  if (search) listParams.set("email", search);
  listParams.set("page", "1");
  listParams.set("pageSize", "10");

  const { data, isLoading } = useQuery({
    queryKey: ["platform", "users", "announce-picker", listParams.toString()],
    queryFn: () => platformQueries.users(listParams.toString()),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  const candidates = (data?.users ?? []).filter((u) => !selected.some((s) => s.id === u.id));
  const atCap = selected.length >= ANNOUNCE_RECIPIENT_CAP;

  const toggle = (u: PlatformUser) => {
    setValidation(null);
    setSelected((prev) => {
      if (prev.some((s) => s.id === u.id)) return prev.filter((s) => s.id !== u.id);
      if (prev.length >= ANNOUNCE_RECIPIENT_CAP) return prev;
      return [...prev, { id: u.id, email: u.email }];
    });
  };

  const submit = async () => {
    const trimmed = message.trim();
    if (selected.length === 0) {
      setValidation(t("announce.validationRecipients"));
      return;
    }
    if (!trimmed) {
      setValidation(t("announce.validationMessage"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await platformMutations.sendAnnouncement({
        recipientUserIds: selected.map((s) => s.id),
        message: trimmed,
      });
      if (result.rejected > 0) {
        toast.warning(t("announce.partialSuccess", { accepted: result.accepted, rejected: result.rejected }));
      } else {
        toast.success(t("announce.success", { accepted: result.accepted }));
      }
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="pf-announce-search">{t("announce.searchLabel")}</Label>
        <Input
          id="pf-announce-search"
          type="email"
          dir="ltr"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="user@example.com"
        />
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label={t("announce.selectedLabel")}>
          {selected.map((s) => (
            <Badge key={s.id} variant="outline" className="gap-1 py-1">
              <span dir="ltr" className="text-xs">{s.email}</span>
              <button
                type="button"
                aria-label={`${t("common.remove")} ${s.email}`}
                className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setSelected((prev) => prev.filter((x) => x.id !== s.id))}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs" aria-live="polite">
        {t("announce.selectedCount", { selected: selected.length, cap: ANNOUNCE_RECIPIENT_CAP })}
        {atCap ? ` — ${t("announce.capReached")}` : ""}
      </p>

      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2" role="listbox" aria-label={t("announce.resultsLabel")}>
        {isLoading ? (
          <p className="text-muted-foreground p-2 text-xs">{t("announce.searching")}</p>
        ) : candidates.length === 0 ? (
          <p className="text-muted-foreground p-2 text-xs">{t("announce.noResults")}</p>
        ) : (
          candidates.map((u) => (
            <label
              key={u.id}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent/40"
            >
              <Checkbox
                checked={false}
                disabled={atCap}
                onCheckedChange={() => toggle(u)}
                aria-label={u.email}
              />
              <span dir="ltr" className="text-xs font-medium">{u.email}</span>
              {u.name ? <span className="text-muted-foreground truncate text-xs">{u.name}</span> : null}
            </label>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pf-announce-message">{t("announce.messageLabel")}</Label>
        <Textarea
          id="pf-announce-message"
          value={message}
          onChange={(e) => {
            setMessage(e.target.value.slice(0, ANNOUNCE_MESSAGE_MAX));
            setValidation(null);
          }}
          maxLength={ANNOUNCE_MESSAGE_MAX}
          rows={4}
          dir="auto"
          aria-describedby="pf-announce-counter"
        />
        <p id="pf-announce-counter" className="text-muted-foreground text-xs tabular-nums">
          {message.length}/{ANNOUNCE_MESSAGE_MAX}
        </p>
      </div>

      {validation ? (
        <p role="alert" className="text-destructive text-sm">{validation}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">{error}</p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button onClick={() => void submit()} disabled={submitting}>
          {submitting ? t("announce.sending") : t("announce.send")}
        </Button>
      </DialogFooter>
    </div>
  );
}

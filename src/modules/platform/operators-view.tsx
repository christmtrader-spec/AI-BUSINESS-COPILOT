"use client";

/**
 * Platform operator management (§54/§55/§56/§96). SUPER_ADMIN-only
 * mutations, enforced server-side (the UI still renders for READONLY —
 * the server 403s with PLATFORM_PERMISSION_DENIED, never frontend-only
 * authorization §32). Last-super-admin protection is server-side (§55).
 *
 * R64 — per-operator session registry (read: platform:operators:read) with
 * surgical single-session revocation. The revoke affordance is gated by
 * platform:security:manage exactly the way users-view gates its sensitive
 * actions (via usePlatformSelf permissions — hide, not disable, §87).
 *
 * R67 — operator invitations ("admin registration", §9-safe): a super
 * admin mints a single-use expiring redemption link for a named email +
 * role. The token is a credential and is disclosed EXACTLY ONCE in the
 * create dialog (§60 display-once law) — lists carry the invite id only.
 * The invite CTA + revoke are gated by platform:operators:manage (hide,
 * not disable); the list itself is readable with platform:operators:read.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ChevronDown, History, MailPlus, ShieldOff, ShieldPlus, TriangleAlert, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PLATFORM_INVITE_STATUSES,
  platformMutations,
  platformQueries,
  type PlatformInviteCreateResult,
  type PlatformOperator,
  type PlatformOperatorInvite,
  type PlatformOperatorSession,
} from "./platform-api";
import {
  EmptyState,
  ListSkeleton,
  PLATFORM_GRADIENT_CTA,
  PaginationBar,
  ReauthDialog,
  StatusBadge,
  formatDateTime,
  usePlatformErrorText,
} from "./kit";
import { isPlatformSelf, usePlatformSelf } from "./use-platform-self";

const ROLES = [
  "PLATFORM_SUPER_ADMIN",
  "PLATFORM_SUPPORT",
  "PLATFORM_BILLING",
  "PLATFORM_AI_COST",
  "PLATFORM_SECURITY",
  "PLATFORM_READONLY",
];

export function OperatorsView() {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const { status: sessionStatus } = useSession();
  const self = usePlatformSelf(sessionStatus === "authenticated");
  // R65 — the probe can also return the "mfa-required" sentinel; narrow it
  // so the permission checks below only ever see a real operator profile.
  const selfData = isPlatformSelf(self.data) ? self.data : null;
  // R64 — same gating pattern as users-view's suspend/announce affordances:
  // the permission string decides visibility (hide, not disable, §87).
  const canRevokeSessions = !!selfData?.permissions.includes("platform:security:manage");
  // R67 — invite minting/revoke is super-only server-side; the UI hides the
  // affordances for every other role (hide, not disable, §87).
  const canManageOperators = !!selfData?.permissions.includes("platform:operators:manage");
  const [includeInactive, setIncludeInactive] = React.useState(true);
  const [roleTarget, setRoleTarget] = React.useState<PlatformOperator | null>(null);
  const [deactivateTarget, setDeactivateTarget] = React.useState<PlatformOperator | null>(null);
  const [sessionsTarget, setSessionsTarget] = React.useState<PlatformOperator | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "operators", includeInactive],
    queryFn: () =>
      platformQueries.operators(includeInactive ? "?includeInactive=true&pageSize=100" : "?pageSize=100"),
    refetchOnWindowFocus: false,
  });

  const rows = data?.operators ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <UserPlus className="size-4" aria-hidden="true" />
          {t("operators.create")}
        </Button>
        {canManageOperators ? (
          <Button
            size="sm"
            className={PLATFORM_GRADIENT_CTA}
            data-testid="pf-inv-cta"
            onClick={() => setInviteOpen(true)}
          >
            <MailPlus className="size-4" aria-hidden="true" />
            {t("invites.cta")}
          </Button>
        ) : null}
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="accent-foreground size-3.5"
          />
          {t("operators.includeInactive")}
        </label>
      </div>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      ) : rows.length === 0 ? (
        <EmptyState label={t("operators.empty")} />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("operators.email")}</TableHead>
                <TableHead>{t("operators.role")}</TableHead>
                <TableHead>{t("operators.status")}</TableHead>
                <TableHead>{t("operators.created")}</TableHead>
                <TableHead className="text-end">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <span dir="ltr" className="text-xs font-medium">
                      {o.email}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`roles.${o.role}` as Parameters<typeof t>[0])}</Badge>
                  </TableCell>
                  <TableCell>
                    {o.active ? (
                      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                        {t("operators.active")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
                        {t("operators.inactive")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDateTime(o.createdAt)}
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" onClick={() => setSessionsTarget(o)}>
                        <History className="size-3.5" aria-hidden="true" />
                        {t("operators.sessions")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setRoleTarget(o)}>
                        {t("operators.changeRole")}
                      </Button>
                      {o.active ? (
                        <Button variant="outline" size="sm" onClick={() => setDeactivateTarget(o)}>
                          <ShieldOff className="size-3.5" aria-hidden="true" />
                          {t("operators.deactivate")}
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => setDeactivateTarget(o)}>
                          <ShieldPlus className="size-3.5" aria-hidden="true" />
                          {t("operators.activate")}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* R67 — invitation registry ("admin registration"): readable with
          platform:operators:read (the same permission that opens this view);
          mutations inside are gated per affordance. */}
      <InvitationsSection canRevoke={canManageOperators} />

      {roleTarget ? (
        <RoleChangeDialog
          target={roleTarget}
          onClose={() => setRoleTarget(null)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ["platform", "operators"] })}
        />
      ) : null}
      {sessionsTarget ? (
        <OperatorSessionsDialog
          target={sessionsTarget}
          canRevoke={canRevokeSessions}
          onClose={() => setSessionsTarget(null)}
        />
      ) : null}
      {deactivateTarget ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setDeactivateTarget(null)}
          titleKey={
            deactivateTarget.active ? "dialogs.deactivateOperatorTitle" : "dialogs.activateOperatorTitle"
          }
          descriptionKey={
            deactivateTarget.active ? "dialogs.deactivateOperatorBody" : "dialogs.activateOperatorBody"
          }
          values={{ email: deactivateTarget.email }}
          submitting={false}
          onSubmit={({ reason, password }) => {
            platformMutations
              .updateOperator(deactivateTarget.id, {
                active: !deactivateTarget.active,
                reason,
                password,
              })
              .then(() => {
                toast.success(t("operators.opSuccess"));
                void queryClient.invalidateQueries({ queryKey: ["platform", "operators"] });
                setDeactivateTarget(null);
              })
              .catch((e) => toast.error(tError(e)));
          }}
        />
      ) : null}
      {createOpen ? (
        <CreateOperatorDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ["platform", "operators"] })}
        />
      ) : null}
      {inviteOpen ? <InviteDialog onClose={() => setInviteOpen(false)} /> : null}
    </div>
  );
}

function RoleChangeDialog({ target, onClose, onDone }: { target: PlatformOperator; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [role, setRole] = React.useState(target.role);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialogs.roleChangeTitle", { email: target.email })}</DialogTitle>
            <DialogDescription>{t("dialogs.roleChangeBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pf-op-role">{t("operators.newRole")}</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="pf-op-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`roles.${r}` as Parameters<typeof t>[0])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t("operators.currentRole")}: {t(`roles.${target.role}` as Parameters<typeof t>[0])}
            </p>
            <p className="text-muted-foreground text-xs">{t("dialogs.lastAdminHint")}</p>
          </div>
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button disabled={role === target.role} onClick={() => setConfirmOpen(true)}>
              {t("subscriptions.continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmOpen ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setConfirmOpen(false)}
          titleKey="dialogs.roleChangeConfirmTitle"
          descriptionKey="dialogs.roleChangeConfirmBody"
          values={{ email: target.email, role: t(`roles.${role}` as Parameters<typeof t>[0]) }}
          submitting={false}
          onSubmit={({ reason, password }) => {
            platformMutations
              .updateOperator(target.id, { role, reason, password })
              .then(() => {
                toast.success(t("operators.roleSuccess"));
                onDone();
                setConfirmOpen(false);
                onClose();
              })
              .catch((e) => toast.error(tError(e)));
          }}
        />
      ) : null}
    </>
  );
}

function CreateOperatorDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<string>("PLATFORM_SUPPORT");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialogs.createOperatorTitle")}</DialogTitle>
            <DialogDescription>{t("dialogs.createOperatorBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pf-op-email">{t("operators.email")}</Label>
              <Input
                id="pf-op-email"
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-op-newrole">{t("operators.role")}</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="pf-op-newrole">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}` as Parameters<typeof t>[0])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-muted-foreground text-xs">{t("dialogs.createOperatorHint")}</p>
          </div>
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!emailOk} onClick={() => setConfirmOpen(true)}>
              {t("subscriptions.continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmOpen ? (
        <ReauthDialog
          open
          onOpenChange={(open) => !open && setConfirmOpen(false)}
          titleKey="dialogs.createOperatorConfirmTitle"
          descriptionKey="dialogs.createOperatorConfirmBody"
          values={{ email, role: t(`roles.${role}` as Parameters<typeof t>[0]) }}
          submitting={false}
          onSubmit={({ reason, password }) => {
            platformMutations
              .createOperator({ email, role, reason, password })
              .then(() => {
                toast.success(t("operators.createSuccess"));
                onDone();
                setConfirmOpen(false);
                onClose();
              })
              .catch((e) => toast.error(tError(e)));
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// R64 — per-operator session registry + surgical revocation. The registry is
// readable by anyone holding platform:operators:read (READONLY included);
// revocation is gated by platform:security:manage (the same permission the
// server enforces on DELETE /operators/[id]/sessions/[sessionId]).
// ---------------------------------------------------------------------------

function OperatorSessionsDialog({
  target,
  canRevoke,
  onClose,
}: {
  target: PlatformOperator;
  canRevoke: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("platform");
  const queryClient = useQueryClient();
  const [revokeTarget, setRevokeTarget] = React.useState<PlatformOperatorSession | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "operators", "sessions", target.id],
    queryFn: () => platformQueries.operatorSessions(target.id),
    refetchOnWindowFocus: false,
  });

  // Server orders live-first; mirror it defensively client-side anyway.
  const sessions: PlatformOperatorSession[] = React.useMemo(() => {
    const rows = data?.sessions ?? [];
    return [...rows].sort((a, b) => Number(b.live) - Number(a.live));
  }, [data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["platform", "operators", "sessions", target.id] });
  };

  /** Live → success, revoked → muted, expired (not revoked, past expiresAt) → outline. */
  const sessionBadge = (s: PlatformOperatorSession) => {
    if (s.revoked) {
      return (
        <Badge variant="outline" className="border-border bg-muted text-muted-foreground whitespace-nowrap">
          {t("operators.sessionRevoked")}
        </Badge>
      );
    }
    if (!s.live) {
      return (
        <Badge variant="outline" className="whitespace-nowrap">
          {t("operators.sessionExpired")}
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 whitespace-nowrap"
      >
        {t("operators.sessionLive")}
      </Badge>
    );
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="pf-op-sess-dialog">
          <DialogHeader>
            <DialogTitle>{t("operators.sessionsTitle", { email: target.email })}</DialogTitle>
            <DialogDescription>
              {t("operators.sessionsActiveCount", { count: data?.activeCount ?? 0 })}
              {data?.truncated ? ` — ${t("operators.sessionsTruncated")}` : ""}
            </DialogDescription>
          </DialogHeader>
          {isLoading ? (
            <ListSkeleton />
          ) : isError ? (
            <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
          ) : sessions.length === 0 ? (
            <EmptyState label={t("operators.sessionsEmpty")} />
          ) : (
            <div className="space-y-2" data-testid="pf-op-sess-list">
              {sessions.map((s) => (
                <div key={s.id} data-testid="pf-op-sess-row" className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {sessionBadge(s)}
                    <span className="text-sm font-medium" dir="auto">
                      {s.deviceLabel ?? t("operators.sessionsUnknownDevice")}
                    </span>
                    {canRevoke && s.live ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ms-auto"
                        data-testid="pf-op-sess-revoke"
                        onClick={() => setRevokeTarget(s)}
                      >
                        {t("operators.sessionRevoke")}
                      </Button>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    <span>
                      {t("operators.sessionCreated")}: {formatDateTime(s.createdAt)}
                    </span>
                    <span>
                      {t("operators.sessionLastSeen")}: {formatDateTime(s.lastSeenAt)}
                    </span>
                    {s.ipHashPrefix ? (
                      <span>
                        ip:{" "}
                        <span className="font-mono" dir="ltr">{`ip#${s.ipHashPrefix}`}</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {revokeTarget ? (
        <RevokeSessionDialog
          operator={target}
          session={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onDone={refresh}
        />
      ) : null}
    </>
  );
}

/**
 * Revoke confirmation — same rules as every other platform reason dialog
 * (3..300 chars, audited) PLUS reauthentication, because the server's
 * assertPlatformReauth requires the current password. The live character
 * counter mirrors the announcement composer's pattern.
 */
function RevokeSessionDialog({
  operator,
  session,
  onClose,
  onDone,
}: {
  operator: PlatformOperator;
  session: PlatformOperatorSession;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSubmit = reason.trim().length >= 3 && password.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await platformMutations.revokeOperatorSession(operator.id, session.id, {
        reason: reason.trim(),
        password,
      });
      // Idempotent server: a lost race still reports revoked=true but honest
      // alreadyRevoked — surfaced as info, not as a fake success.
      if (res.alreadyRevoked) {
        toast.info(t("operators.revokeAlreadyRevoked"));
      } else {
        toast.success(t("operators.revokeSuccess"));
      }
      onDone();
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pf-op-sess-confirm">
        <DialogHeader>
          <DialogTitle>{t("operators.revokeTitle")}</DialogTitle>
          <DialogDescription>{t("operators.revokeDesc", { email: operator.email })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pf-op-sess-reason">{t("dialogs.reason")}</Label>
            <Textarea
              id="pf-op-sess-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 300))}
              rows={2}
              maxLength={300}
              placeholder={t("dialogs.reasonPlaceholder")}
              aria-describedby="pf-op-sess-reason-counter"
            />
            <p id="pf-op-sess-reason-counter" className="text-muted-foreground text-xs tabular-nums">
              {reason.length}/300
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pf-op-sess-password">{t("dialogs.currentPassword")}</Label>
            <Input
              id="pf-op-sess-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <p className="text-muted-foreground text-xs">{t("dialogs.reauthHint")}</p>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? t("common.working") : t("operators.revokeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// R67 — operator invitations ("admin registration"). The list is a
// collapsible section BELOW the operators table (this view has no tabs);
// desktop renders a table (hidden md:block) and 390px gets stacked cards —
// the same two-render pattern as the approvals view. The redemption token
// NEVER appears here (§14): only the create dialog discloses it, once.
// ---------------------------------------------------------------------------

const INVITES_PAGE_SIZE = 10;

function inviteStatusLabel(
  t: ReturnType<typeof useTranslations>,
  status: string,
): string {
  const key = PLATFORM_INVITE_STATUSES.includes(
    status as (typeof PLATFORM_INVITE_STATUSES)[number],
  )
    ? status
    : "PENDING";
  return t(`invites.status.${key}` as Parameters<typeof t>[0]);
}

function InvitationsSection({ canRevoke }: { canRevoke: boolean }) {
  const t = useTranslations("platform");
  const [open, setOpen] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [revokeTarget, setRevokeTarget] = React.useState<PlatformOperatorInvite | null>(null);

  // Fetched only while the section is open (no platform prefetch for a
  // collapsed panel); placeholderData keeps pagination stable.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "invites", page],
    queryFn: () => platformQueries.operatorInvites(`?page=${page}&pageSize=${INVITES_PAGE_SIZE}`),
    enabled: open,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const rows = data?.invites ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="pf-inv-list">
      <div className="overflow-hidden rounded-md border">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-accent/40 flex w-full items-center gap-2 px-4 py-3 text-start"
            aria-expanded={open}
            data-testid="pf-inv-toggle"
          >
            <span className="grid flex-1 leading-tight">
              <span className="text-sm font-semibold">{t("invites.title")}</span>
              <span className="text-muted-foreground text-xs">{t("invites.description")}</span>
            </span>
            {open || data ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {t("invites.totalCount", { count: data?.page.total ?? 0 })}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t p-4">
            {isLoading ? (
              <ListSkeleton />
            ) : isError ? (
              <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
            ) : rows.length === 0 ? (
              <EmptyState label={t("invites.empty")} />
            ) : (
              <>
                {/* Desktop table — overflow-x-auto wrapper, same as approvals. */}
                <div className="hidden overflow-x-auto rounded-md border md:block" data-testid="pf-inv-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("operators.email")}</TableHead>
                        <TableHead>{t("invites.colName")}</TableHead>
                        <TableHead>{t("operators.role")}</TableHead>
                        <TableHead>{t("invites.colStatus")}</TableHead>
                        <TableHead>{t("invites.colInviter")}</TableHead>
                        <TableHead>{t("invites.colDate")}</TableHead>
                        <TableHead className="text-end">{t("common.actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((i) => (
                        <TableRow key={i.id} data-testid="pf-inv-row">
                          <TableCell>
                            <span dir="ltr" className="font-mono text-xs font-medium">
                              {i.email}
                            </span>
                          </TableCell>
                          <TableCell className="text-sm">{i.name}</TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {t(`roles.${i.role}` as Parameters<typeof t>[0])}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={i.status} label={inviteStatusLabel(t, i.status)} />
                          </TableCell>
                          <TableCell>
                            <span dir="ltr" className="text-muted-foreground font-mono text-xs">
                              {i.createdBy?.email ?? "—"}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {i.acceptedAt
                              ? t("invites.acceptedAt", {
                                  date: formatDateTime(i.acceptedAt),
                                })
                              : t("invites.expiresAt", { date: formatDateTime(i.expiresAt) })}
                          </TableCell>
                          <TableCell className="text-end">
                            {canRevoke && i.status === "PENDING" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                data-testid="pf-inv-revoke"
                                onClick={() => setRevokeTarget(i)}
                              >
                                {t("invites.revoke")}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile cards (390px) — stacked, wrap-safe. */}
                <div className="space-y-2 md:hidden" data-testid="pf-inv-cards">
                  {rows.map((i) => (
                    <div key={i.id} className="rounded-md border p-3" data-testid="pf-inv-row">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span dir="ltr" className="font-mono text-xs font-medium">
                          {i.email}
                        </span>
                        <StatusBadge status={i.status} label={inviteStatusLabel(t, i.status)} />
                      </div>
                      <p className="mt-1 text-sm" dir="auto">
                        {i.name}
                      </p>
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <Badge variant="outline">
                          {t(`roles.${i.role}` as Parameters<typeof t>[0])}
                        </Badge>
                        <span dir="ltr" className="font-mono">
                          {i.createdBy?.email ?? "—"}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {i.acceptedAt
                          ? t("invites.acceptedAt", { date: formatDateTime(i.acceptedAt) })
                          : t("invites.expiresAt", { date: formatDateTime(i.expiresAt) })}
                      </p>
                      {canRevoke && i.status === "PENDING" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          data-testid="pf-inv-revoke"
                          onClick={() => setRevokeTarget(i)}
                        >
                          {t("invites.revoke")}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="mt-3">
                  <PaginationBar
                    page={data?.page.page ?? 1}
                    hasNext={data?.page.hasNext ?? false}
                    onPrev={() => setPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPage((p) => p + 1)}
                  />
                </div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>

      {revokeTarget ? (
        <RevokeInviteDialog
          invite={revokeTarget}
          onClose={() => setRevokeTarget(null)}
        />
      ) : null}
    </Collapsible>
  );
}

/**
 * R67 — invite minting. One dialog: name/email/role/reason + the SAME
 * reauth password contract as every other sensitive dialog in this view.
 * On 201 the body swaps to the ONE-TIME disclosure (§60): warning, the
 * full redemption link in a mono dir=ltr readonly input, Copy with an
 * honest success toast, the server-stated expiry window, and a single
 * Done exit — dismissal is locked while the token is on screen so a
 * stray Esc cannot silently destroy the only copy.
 */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<string>("PLATFORM_SUPPORT");
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // ONE-TIME disclosure state (§60) — the token leaves client state on close.
  const [result, setResult] = React.useState<PlatformInviteCreateResult | null>(null);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  const canSubmit =
    name.trim().length >= 2 && emailOk && reason.trim().length >= 3 && password.length > 0 && !submitting;

  const refreshInvites = () => {
    void queryClient.invalidateQueries({ queryKey: ["platform", "invites"] });
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await platformMutations.createOperatorInvite({
        email: email.trim(),
        name: name.trim(),
        role,
        reason: reason.trim(),
        password,
      });
      setPassword("");
      setResult(res); // the token exists ONLY in this state, shown once
      refreshInvites();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.redemptionUrl);
      toast.success(t("invites.copied"));
    } catch {
      // Clipboard denied (permissions/private mode) — the raw link stays
      // visible and selectable in the input; never faked as copied.
    }
  };

  const close = () => {
    setResult(null);
    refreshInvites();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !result) onClose();
        // While the one-time token is on screen the ONLY exit is Done —
        // same law as the MFA recovery codes dialog (§60).
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-md"
        showCloseButton={!result}
        data-testid="pf-inv-dialog"
      >
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("invites.onceTitle")}</DialogTitle>
              <DialogDescription>{t("invites.onceBody")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4" data-testid="pf-inv-once">
              <div
                className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 flex items-start gap-2 rounded-md border p-3 text-sm"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t("invites.onceWarning")}</span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pf-inv-link">{t("invites.linkLabel")}</Label>
                <Input
                  id="pf-inv-link"
                  readOnly
                  value={result.redemptionUrl}
                  dir="ltr"
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="pf-inv-link-input"
                />
                <Button variant="outline" size="sm" onClick={() => void copyLink()} data-testid="pf-inv-copy">
                  {t("invites.copy")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("invites.expiryNote", { hours: result.expiresInHours })}
              </p>
            </div>
            <DialogFooter>
              <Button onClick={close} data-testid="pf-inv-done">
                {t("invites.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("invites.dialogTitle")}</DialogTitle>
              <DialogDescription>{t("invites.dialogBody")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pf-inv-name">{t("invites.name")}</Label>
                <Input
                  id="pf-inv-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 80))}
                  dir="auto"
                  maxLength={80}
                  autoComplete="off"
                  data-testid="pf-inv-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-inv-email">{t("operators.email")}</Label>
                <Input
                  id="pf-inv-email"
                  type="email"
                  dir="ltr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@example.com"
                  autoComplete="off"
                  data-testid="pf-inv-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-inv-role">{t("operators.role")}</Label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger id="pf-inv-role" data-testid="pf-inv-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}` as Parameters<typeof t>[0])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-inv-reason">{t("dialogs.reason")}</Label>
                <Textarea
                  id="pf-inv-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value.slice(0, 300))}
                  rows={2}
                  maxLength={300}
                  placeholder={t("dialogs.reasonPlaceholder")}
                  aria-describedby="pf-inv-reason-counter"
                  data-testid="pf-inv-reason"
                />
                <p id="pf-inv-reason-counter" className="text-muted-foreground text-xs tabular-nums">
                  {reason.length}/300
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pf-inv-password">{t("dialogs.currentPassword")}</Label>
                <Input
                  id="pf-inv-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  data-testid="pf-inv-password"
                />
                <p className="text-muted-foreground text-xs">{t("dialogs.reauthHint")}</p>
              </div>
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter className="sm:justify-between">
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                {t("common.cancel")}
              </Button>
              <Button
                className={PLATFORM_GRADIENT_CTA}
                disabled={!canSubmit}
                onClick={() => void submit()}
                data-testid="pf-inv-submit"
              >
                {submitting ? t("common.working") : t("invites.submit")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Revoke confirmation — mirrors RevokeSessionDialog exactly: reason 3..300
 * with a live counter + current-password reauth (assertPlatformReauth
 * server-side). Idempotent server (§210): an already-revoked invite still
 * answers 200 with alreadyRevoked — surfaced as info, never fake success.
 */
function RevokeInviteDialog({
  invite,
  onClose,
}: {
  invite: PlatformOperatorInvite;
  onClose: () => void;
}) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSubmit = reason.trim().length >= 3 && password.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await platformMutations.revokeOperatorInvite(invite.id, {
        reason: reason.trim(),
        password,
      });
      if (res.alreadyRevoked) {
        toast.info(t("invites.revokeAlreadyRevoked"));
      } else {
        toast.success(t("invites.revokeSuccess"));
      }
      void queryClient.invalidateQueries({ queryKey: ["platform", "invites"] });
      onClose();
    } catch (e) {
      setError(tError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pf-inv-revoke-dialog">
        <DialogHeader>
          <DialogTitle>{t("invites.revokeTitle")}</DialogTitle>
          <DialogDescription>{t("invites.revokeDesc", { email: invite.email })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pf-inv-revoke-reason">{t("dialogs.reason")}</Label>
            <Textarea
              id="pf-inv-revoke-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 300))}
              rows={2}
              maxLength={300}
              placeholder={t("dialogs.reasonPlaceholder")}
              aria-describedby="pf-inv-revoke-reason-counter"
            />
            <p id="pf-inv-revoke-reason-counter" className="text-muted-foreground text-xs tabular-nums">
              {reason.length}/300
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pf-inv-revoke-password">{t("dialogs.currentPassword")}</Label>
            <Input
              id="pf-inv-revoke-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <p className="text-muted-foreground text-xs">{t("dialogs.reauthHint")}</p>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()} data-testid="pf-inv-revoke-confirm">
            {submitting ? t("common.working") : t("invites.revokeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

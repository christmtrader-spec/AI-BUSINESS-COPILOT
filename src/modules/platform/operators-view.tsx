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
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { History, ShieldOff, ShieldPlus, UserPlus } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  platformMutations,
  platformQueries,
  type PlatformOperator,
  type PlatformOperatorSession,
} from "./platform-api";
import { EmptyState, ListSkeleton, ReauthDialog, formatDateTime, usePlatformErrorText } from "./kit";
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
  const [includeInactive, setIncludeInactive] = React.useState(true);
  const [roleTarget, setRoleTarget] = React.useState<PlatformOperator | null>(null);
  const [deactivateTarget, setDeactivateTarget] = React.useState<PlatformOperator | null>(null);
  const [sessionsTarget, setSessionsTarget] = React.useState<PlatformOperator | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

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

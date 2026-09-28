"use client";

/**
 * Platform operator management (§54/§55/§56/§96). SUPER_ADMIN-only
 * mutations, enforced server-side (the UI still renders for READONLY —
 * the server 403s with PLATFORM_PERMISSION_DENIED, never frontend-only
 * authorization §32). Last-super-admin protection is server-side (§55).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ShieldOff, ShieldPlus, UserPlus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { platformMutations, platformQueries, type PlatformOperator } from "./platform-api";
import { EmptyState, ListSkeleton, ReauthDialog, formatDateTime, usePlatformErrorText } from "./kit";

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
  const [includeInactive, setIncludeInactive] = React.useState(true);
  const [roleTarget, setRoleTarget] = React.useState<PlatformOperator | null>(null);
  const [deactivateTarget, setDeactivateTarget] = React.useState<PlatformOperator | null>(null);
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

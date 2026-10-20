"use client";

/**
 * Platform user search (§21) + session invalidation (§22). The DTO is an
 * explicit allowlist — passwordHash never crosses this UI (§83).
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { usePlatformSelf } from "./use-platform-self";
import { useSession } from "next-auth/react";

const PAGE_SIZE = 20;

export function UsersView() {
  const t = useTranslations("platform");
  const { status: sessionStatus } = useSession();
  const self = usePlatformSelf(sessionStatus === "authenticated");
  const canSuspend = !!self.data?.permissions.includes("platform:users:suspend");
  const [email, setEmail] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [invalidateTarget, setInvalidateTarget] = React.useState<PlatformUser | null>(null);
  const [suspendTarget, setSuspendTarget] = React.useState<PlatformUser | null>(null);
  const [reactivateTarget, setReactivateTarget] = React.useState<PlatformUser | null>(null);

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

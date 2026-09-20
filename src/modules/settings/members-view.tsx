"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { ROLES, ROLE_RANK, asRole, can, permissionsOf, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, Ltr } from "@/components/shared/data-table";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/primitives";
import type { BusinessListItem, MemberItem } from "../shell/types";

// ---- Invite links -------------------------------------------------------------

type InviteItem = {
  id: string;
  role: string;
  tokenTail: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  createdBy: { name: string | null; email: string } | null;
  acceptedBy: { name: string | null; email: string } | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

type CreatedInvite = {
  id: string;
  role: string;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export function MembersView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const uiLocale = useLocale();
  const activeId = useAppStore((s) => s.activeBusinessId);
  const queryClient = useQueryClient();

  const role = asRole(membership.role);
  const manage = can(role, "members:manage");

  const { data: members, isLoading, isFetching, error, refetch } = useQuery<MemberItem[]>({
    queryKey: ["members", activeId],
    queryFn: () => api(`/api/v1/businesses/${activeId}/members`),
    enabled: can(role, "members:read"),
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("VIEWER");

  const addMutation = useMutation({
    mutationFn: async () =>
      api(`/api/v1/businesses/${activeId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      }),
    onSuccess: () => {
      toast({ title: t("memberAddedToast") });
      setInviteEmail("");
      setInviteRole("VIEWER");
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const roleMutation = useMutation({
    mutationFn: async ({ memberId, newRole }: { memberId: string; newRole: Role }) =>
      api(`/api/v1/businesses/${activeId}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      }),
    onSuccess: () => {
      toast({ title: t("roleChangedToast") });
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (memberId: string) =>
      api(`/api/v1/businesses/${activeId}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("memberRemovedToast") });
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  // ---- Invite links ---------------------------------------------------------
  const [inviteRoleLink, setInviteRoleLink] = useState<Role>("VIEWER");
  const [inviteExpiry, setInviteExpiry] = useState<"1" | "7" | "30">("7");
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const { data: invites } = useQuery<InviteItem[]>({
    queryKey: ["invites", activeId],
    queryFn: () => api(`/api/v1/businesses/${activeId}/invites`),
    enabled: can(role, "members:read"),
    staleTime: 15_000,
  });
  const pendingInvites = (invites ?? []).filter((i) => i.status === "PENDING");

  const createInviteMutation = useMutation({
    mutationFn: async () =>
      api<CreatedInvite>(`/api/v1/businesses/${activeId}/invites`, {
        method: "POST",
        body: JSON.stringify({
          role: inviteRoleLink,
          expiresInDays: Number(inviteExpiry),
        }),
      }),
    onSuccess: (data) => {
      setCreatedInvite(data);
      setInviteCopied(false);
      void queryClient.invalidateQueries({ queryKey: ["invites"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: async (inviteId: string) =>
      api(`/api/v1/businesses/${activeId}/invites/${inviteId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("inviteRevokedToast") });
      void queryClient.invalidateQueries({ queryKey: ["invites"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const copyInviteLink = async () => {
    if (!createdInvite) return;
    try {
      const url = `${window.location.origin}/#/join/${createdInvite.token}`;
      await navigator.clipboard.writeText(url);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
      toast({ title: t("inviteCopiedToast") });
    } catch {
      toast({ title: t("inviteCopyFailed"), variant: "destructive" });
    }
  };

  const formatExpiry = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16).replace("T", " ");
    }
  };

  function canModifyTarget(target: MemberItem): boolean {
    if (!manage) return false;
    if (target.user.id === membership.business.ownerId && target.isOwner) {
      // The business owner can only be managed by an OWNER.
      return role === "OWNER";
    }
    if (ROLE_RANK[asRole(target.role)] >= ROLE_RANK[role] && role !== "OWNER") return false;
    return true;
  }

  // Roles the actor may assign: strictly below own rank (OWNER may assign all except replacing themselves as owner).
  const assignableRoles = ROLES.filter((r) => {
    if (role === "OWNER") return r !== "OWNER";
    return ROLE_RANK[r] < ROLE_RANK[role];
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-view="settings:members">
      <PageHeader title={t("membersTitle")} subtitle={t("membersSubtitle")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="text-primary size-4" aria-hidden="true" />
            {t("permissionNote", { role: t(`roles.${role}` as "OWNER") })}
          </CardTitle>
          <CardDescription>
            {permissionsOf(role).length} {t("rolePerms")}
          </CardDescription>
        </CardHeader>
      </Card>

      {manage ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="text-primary size-4" aria-hidden="true" />
              {t("inviteLinkTitle")}
            </CardTitle>
            <CardDescription>{t("inviteLinkDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="invite-link-role">{t("role")}</Label>
                <Select
                  value={inviteRoleLink}
                  onValueChange={(v) => setInviteRoleLink(v as Role)}
                >
                  <SelectTrigger id="invite-link-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}` as "OWNER")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:w-40">
                <Label htmlFor="invite-link-expiry">{t("inviteExpiry")}</Label>
                <Select
                  value={inviteExpiry}
                  onValueChange={(v) => setInviteExpiry(v as "1" | "7" | "30")}
                >
                  <SelectTrigger id="invite-link-expiry" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t("expiry_1")}</SelectItem>
                    <SelectItem value="7">{t("expiry_7")}</SelectItem>
                    <SelectItem value="30">{t("expiry_30")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                onClick={() => createInviteMutation.mutate()}
                disabled={createInviteMutation.isPending}
              >
                {createInviteMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Link2 className="size-4" aria-hidden="true" />
                )}
                {t("inviteGenerate")}
              </Button>
            </div>

            {createdInvite ? (
              <div className="border-emerald-500/30 bg-emerald-500/5 mt-4 rounded-lg border p-3">
                <p className="text-xs font-medium">{t("inviteLinkResult")}</p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    readOnly
                    dir="ltr"
                    value={`${typeof window !== "undefined" ? window.location.origin : ""}/#/join/${createdInvite.token}`}
                    onFocus={(e) => e.currentTarget.select()}
                    className="bg-background h-9 min-w-0 flex-1 rounded-md border px-2.5 font-mono text-xs"
                    aria-label={t("inviteLinkResult")}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0 gap-1.5"
                    onClick={() => void copyInviteLink()}
                  >
                    {inviteCopied ? (
                      <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    ) : (
                      <Copy className="size-4" aria-hidden="true" />
                    )}
                    {inviteCopied ? tCommon("copied") : tCommon("copy")}
                  </Button>
                </div>
                <p className="text-muted-foreground mt-2 text-[11px]">
                  {t("inviteExpiresNote", { date: formatExpiry(createdInvite.expiresAt) })}
                </p>
              </div>
            ) : null}

            {pendingInvites.length > 0 ? (
              <div className="mt-4">
                <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                  {t("pendingInvites")} ({pendingInvites.length})
                </p>
                <ul className="max-h-40 space-y-1.5 overflow-y-auto pe-1">
                  {pendingInvites.map((inv) => (
                    <li
                      key={inv.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="shrink-0">
                          {t(`roles.${asRole(inv.role)}` as "OWNER")}
                        </Badge>
                        <span className="text-muted-foreground truncate" dir="ltr">
                          ····{inv.tokenTail}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          · {t("inviteExpires", { date: formatExpiry(inv.expiresAt) })}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive size-7 shrink-0"
                        onClick={() => revokeInviteMutation.mutate(inv.id)}
                        disabled={revokeInviteMutation.isPending}
                        aria-label={t("inviteRevokeAction")}
                        title={t("inviteRevokeAction")}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {manage ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="text-primary size-4" aria-hidden="true" />
              {t("addMember")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (inviteEmail.trim()) addMutation.mutate();
              }}
              noValidate
            >
              <div className="flex-1 space-y-2">
                <Label htmlFor="invite-email">{t("inviteEmail")}</Label>
                <Input
                  id="invite-email"
                  type="email"
                  dir="ltr"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t("inviteEmailPlaceholder")}
                  required
                />
              </div>
              <div className="space-y-2 sm:w-44">
                <Label htmlFor="invite-role">{t("role")}</Label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}` as "OWNER")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={addMutation.isPending || !inviteEmail.trim()}>
                {addMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <UserPlus className="size-4" aria-hidden="true" />
                )}
                {addMutation.isPending ? t("adding") : t("addMember")}
              </Button>
            </form>
            <p className="text-muted-foreground mt-2 text-xs">{t("lastOwnerNote")}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="text-primary size-4" aria-hidden="true" />
            {t("membersTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <DataTable<MemberItem>
              ariaLabel={t("membersTitle")}
              sortLocale={uiLocale}
              maxHeightClass="max-h-96"
              stickyHeader
              refreshing={isFetching && !isLoading}
              columns={[
                {
                  id: "member",
                  header: t("membersTitle"),
                  sortValue: (m) => m.user.name ?? m.user.email,
                  cell: (m) => {
                    const initials = (m.user.name ?? m.user.email)
                      .slice(0, 2)
                      .toUpperCase();
                    const self = m.id === membership.memberId;
                    return (
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {m.user.name ?? m.user.email}{" "}
                            {self ? (
                              <span className="text-muted-foreground">({t("you")})</span>
                            ) : null}
                            {m.isOwner ? (
                              <Badge variant="secondary" className="ms-2">
                                {t("owner")}
                              </Badge>
                            ) : null}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">
                            <Ltr>{m.user.email}</Ltr>
                          </p>
                        </div>
                      </div>
                    );
                  },
                },
                {
                  id: "role",
                  header: t("role"),
                  cell: (m) =>
                    canModifyTarget(m) && asRole(m.role) !== "OWNER" ? (
                      <Select
                        value={asRole(m.role)}
                        onValueChange={(v) =>
                          roleMutation.mutate({ memberId: m.id, newRole: v as Role })
                        }
                        disabled={roleMutation.isPending}
                      >
                        <SelectTrigger className="h-8 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {assignableRoles.concat(asRole(m.role)).filter((r, i, arr) => arr.indexOf(r) === i).map((r) => (
                            <SelectItem key={r} value={r}>
                              {t(`roles.${r}` as "OWNER")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline">{t(`roles.${asRole(m.role)}` as "OWNER")}</Badge>
                    ),
                },
                {
                  id: "actions",
                  header: tCommon("actions"),
                  align: "end",
                  cell: (m) =>
                    canModifyTarget(m) && asRole(m.role) !== "OWNER" ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" aria-label={tCommon("delete")}>
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>{t("removeDesc")}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => removeMutation.mutate(m.id)}
                            >
                              {tCommon("delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null,
                },
              ]}
              rows={members ?? []}
              getRowId={(m) => m.id}
              loading={isLoading}
              skeletonRows={4}
              empty={
                <p className="text-muted-foreground px-3 py-6 text-sm">{tErrors("notFound")}</p>
              }
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

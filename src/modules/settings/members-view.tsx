"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { ROLES, ROLE_RANK, asRole, can, permissionsOf, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

export function MembersView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const activeId = useAppStore((s) => s.activeBusinessId);
  const queryClient = useQueryClient();

  const role = asRole(membership.role);
  const manage = can(role, "members:manage");

  const { data: members, isLoading, error, refetch } = useQuery<MemberItem[]>({
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
          {isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted/50 h-12 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : !members || members.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tErrors("notFound")}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50 sticky top-0">
                  <TableRow>
                    <TableHead>{t("membersTitle")}</TableHead>
                    <TableHead>{t("role")}</TableHead>
                    <TableHead className="text-end">{tCommon("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => {
                    const initials = (m.user.name ?? m.user.email)
                      .slice(0, 2)
                      .toUpperCase();
                    const self = m.id === membership.memberId;
                    const modifiable = canModifyTarget(m);
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
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
                              <p className="text-muted-foreground truncate text-xs" dir="ltr">
                                {m.user.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {modifiable && asRole(m.role) !== "OWNER" ? (
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
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          {modifiable && asRole(m.role) !== "OWNER" ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" aria-label={tCommon("delete")}>
                                  <Trash2 className="size-4" />
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
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

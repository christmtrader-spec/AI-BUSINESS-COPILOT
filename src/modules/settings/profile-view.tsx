"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { KeyRound, Loader2, RotateCcw, Save, Scale, Sparkles, TriangleAlert, UserRound } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { localeLabel, LOCALES } from "@/i18n/config";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { isPlatformSelf, usePlatformSelf } from "@/modules/platform/use-platform-self";
import { PageHeader } from "@/components/shared/primitives";

type Me = {
  id: string;
  name: string | null;
  email: string;
  locale: string;
  createdAt: string;
  // R140 — additive R108 field (older cached responses honestly omit it;
  // absent reads as "never dismissed").
  checklistDismissedAt?: string | null;
};
type OwnedBusiness = { id: string; name: string; members: number };
/** Minimal legal metadata (Prompt 27 §161) — nothing internal crosses the API. */
type LegalDocMeta = {
  documentType: string;
  version: string;
  effectiveDate: string | null;
  lastUpdated: string;
};
type LegalAcceptanceRecord = {
  documentType: string;
  documentVersion: string;
  locale: string;
  acceptedAt: string;
};

/** Narrows the 409 OWNED_BUSINESS_BLOCKED details into the owned-business list. */
function ownedBusinessesOf(err: unknown): OwnedBusiness[] {
  if (!(err instanceof ApiClientError) || err.code !== "OWNED_BUSINESS_BLOCKED") return [];
  const details = err.details as { ownedBusinesses?: unknown } | null | undefined;
  const list = details?.ownedBusinesses;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (b): b is OwnedBusiness =>
      !!b &&
      typeof b === "object" &&
      typeof (b as OwnedBusiness).id === "string" &&
      typeof (b as OwnedBusiness).name === "string",
  );
}

const deleteConfirmWord = "DELETE";

export function ProfileView() {
  const t = useTranslations("profile");
  const tAuth = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const tLegal = useTranslations("legal.settings");
  const queryClient = useQueryClient();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  const { data: me } = useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => api("/api/v1/me", { businessId: null }),
  });

  // Legal & Privacy section (Prompt 27 §103–§105): current document versions
  // and the CURRENT USER's own acceptance records (server session-resolved).
  const {
    data: legalDocs,
    isError: legalDocsError,
  } = useQuery<LegalDocMeta[]>({
    queryKey: ["legal-documents"],
    queryFn: async () => {
      const res = (await api("/api/v1/legal/documents", {
        businessId: null,
      })) as { documents: LegalDocMeta[] };
      return res.documents;
    },
    staleTime: 5 * 60_000,
  });
  const {
    data: legalAcceptances,
    isError: legalAcceptancesError,
  } = useQuery<LegalAcceptanceRecord[]>({
    queryKey: ["legal-acceptances"],
    queryFn: async () => {
      const res = (await api("/api/v1/legal/acceptance", {
        businessId: null,
      })) as { acceptances: LegalAcceptanceRecord[] };
      return res.acceptances;
    },
  });
  void legalAcceptancesError;

  const [name, setName] = useState("");
  const [syncedName, setSyncedName] = useState<string | null>(null);

  // Prompt 28 — operator capability probe (only when the profile renders).
  // R65 — narrow the probe union: only a REAL operator profile (not the
  // "mfa-required" sentinel) may reveal the console entry point.
  const { data: platformSelf } = usePlatformSelf(true);
  const operatorSelf = isPlatformSelf(platformSelf) ? platformSelf : null;
  // React "adjust state during render" pattern — avoids setState-in-effect.
  if (me && me.name !== syncedName) {
    setSyncedName(me.name);
    setName(me.name ?? "");
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      name?: string;
      locale?: string;
      checklistDismissed?: boolean;
    }) =>
      api<Me>("/api/v1/me", {
        method: "PATCH",
        businessId: null,
        body: JSON.stringify(payload),
      }),
    onSuccess: (data, payload) => {
      // R140 — the restore path carries its own toast (the name/locale path
      // keeps the generic one; a PATCH that mixes them gets the generic).
      if (payload.checklistDismissed === false && payload.name === undefined && payload.locale === undefined) {
        toast({ title: t("welcomeCardRestoreToast") });
      } else {
        toast({ title: t("savedToast") });
      }
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      // R143 — the locale CONFIRMATION law (closes the R141 observed flip):
      // the response's /me.locale may only drive the UI when THIS mutation
      // explicitly asked for a language change. A name save or the
      // welcome-card restore PATCH carries the full /me body back — applying
      // its persisted locale used to flip the active UI language mid-action
      // (e.g. FA → EN on restore). The language Select below is the ONLY
      // producer of payload.locale.
      if (payload.locale !== undefined && data.locale && data.locale !== locale) {
        setLocale(data.locale === "fa" ? "fa" : "en");
      }
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  function onLanguageChange(next: string) {
    setLocale(next === "fa" ? "fa" : "en");
    saveMutation.mutate({ locale: next });
  }

  // --- Change password ----------------------------------------------
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);

  const changePasswordMutation = useMutation({
    mutationFn: async () =>
      api<{ changed: boolean; sessionsInvalidated: boolean }>(
        "/api/v1/auth/password-change",
        {
          method: "POST",
          businessId: null,
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
        },
      ),
    onSuccess: () => {
      setChangeError(null);
      // ALL sessions (including this one) are invalidated server-side —
      // clear the local session; the app falls back to the signed-in gate.
      toast({ title: tAuth("changePasswordSuccess") });
      void signOut({ redirect: false });
      void queryClient.invalidateQueries();
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.code === "INVALID_CURRENT_PASSWORD") setChangeError(tAuth("errors.invalidCurrentPassword"));
        else if (err.code === "PASSWORD_UNCHANGED") setChangeError(tAuth("errors.passwordUnchanged"));
        else if (err.code === "SESSION_INVALIDATED") setChangeError(tAuth("errors.sessionInvalidated"));
        else if (err.code === "RATE_LIMITED") setChangeError(tAuth("errors.rateLimited"));
        else if (err.status === 0) setChangeError(tErrors("network"));
        else setChangeError(tErrors("generic"));
      } else {
        setChangeError(tErrors("generic"));
      }
    },
  });

  function onChangePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChangeError(null);
    if (newPassword !== confirmPassword) {
      setChangeError(tAuth("errors.passwordMismatch"));
      return;
    }
    changePasswordMutation.mutate();
  }

  // --- Delete account ------------------------------------------------
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [ownedBlocked, setOwnedBlocked] = useState<OwnedBusiness[] | null>(null);

  const deleteAccountMutation = useMutation({
    mutationFn: async () =>
      api<{ deleted: boolean; sessionsInvalidated: boolean }>("/api/v1/me", {
        method: "DELETE",
        businessId: null,
        body: JSON.stringify({ password: deletePassword, confirmation: deleteConfirmation }),
      }),
    onSuccess: () => {
      setDeleteOpen(false);
      toast({ title: tAuth("deleteSuccess") });
      // Account is gone and every session is invalidated — sign out; the
      // app falls back to the AuthView signed-out gate automatically.
      void signOut({ redirect: false });
      void queryClient.invalidateQueries();
    },
    onError: (err) => {
      const blocked = ownedBusinessesOf(err);
      if (blocked.length > 0) {
        setOwnedBlocked(blocked);
        setDeleteError(tAuth("deleteAccountBlocked"));
        return; // do NOT sign out — the account still exists
      }
      if (err instanceof ApiClientError) {
        if (err.code === "INVALID_CURRENT_PASSWORD") setDeleteError(tAuth("errors.invalidCurrentPassword"));
        else if (err.code === "RATE_LIMITED") setDeleteError(tAuth("errors.rateLimited"));
        else if (err.status === 0) setDeleteError(tErrors("network"));
        else setDeleteError(tErrors("generic"));
      } else {
        setDeleteError(tErrors("generic"));
      }
    },
  });

  const deleteGated =
    deletePassword.length > 0 && deleteConfirmation === deleteConfirmWord;

  const memberSince = me
    ? new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
        dateStyle: "medium",
      }).format(new Date(me.createdAt))
    : "—";

  return (
    <div className="mx-auto max-w-2xl space-y-6" data-view="profile">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="text-primary size-4" aria-hidden="true" />
            {t("accountSection")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-name">{t("name")}</Label>
            <div className="flex gap-2">
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
              <Button
                variant="outline"
                onClick={() => saveMutation.mutate({ name })}
                disabled={saveMutation.isPending || !name.trim() || name === me?.name}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-email">{t("email")}</Label>
            <Input id="profile-email" value={me?.email ?? ""} disabled dir="ltr" />
          </div>
          <p className="text-muted-foreground text-xs">
            {t("memberSince")}: {memberSince}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="text-primary size-4" aria-hidden="true" />
            {tAuth("changePasswordTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {tAuth("changePasswordDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onChangePasswordSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="change-current">{tAuth("currentPassword")}</Label>
              <Input
                id="change-current"
                type="password"
                autoComplete="current-password"
                dir="ltr"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="change-new">{tAuth("newPassword")}</Label>
              <Input
                id="change-new"
                type="password"
                autoComplete="new-password"
                dir="ltr"
                placeholder={tAuth("passwordPlaceholder")}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
              <p className="text-muted-foreground text-xs">{tAuth("passwordHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="change-confirm">{tAuth("confirmNewPassword")}</Label>
              <Input
                id="change-confirm"
                type="password"
                autoComplete="new-password"
                dir="ltr"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            {changeError ? (
              <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert">
                {changeError}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={
                changePasswordMutation.isPending ||
                !currentPassword ||
                !newPassword ||
                !confirmPassword
              }
            >
              {changePasswordMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="size-4" aria-hidden="true" />
              )}
              {tAuth("changePassword")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("preferencesSection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="profile-language">{t("language")}</Label>
          <Select value={locale} onValueChange={onLanguageChange}>
            <SelectTrigger id="profile-language" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((l) => (
                <SelectItem key={l} value={l}>
                  {localeLabel(l)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t("languageHint")}</p>
        </CardContent>
      </Card>

      {/* R140 — the welcome-card restore row (the R108 contract's other
          half): the card is visible while checklistDismissedAt is null;
          once dismissed the user can restore it HERE (PATCH
          { checklistDismissed: false } — the same shared ["me"] cache the
          dashboard card reads). Both states are honest server facts. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-primary size-4" aria-hidden="true" />
            {t("welcomeCardLabel")}
          </CardTitle>
          <CardDescription className="text-muted-foreground" dir="auto">
            {me?.checklistDismissedAt ? t("welcomeCardHidden") : t("welcomeCardShown")}
          </CardDescription>
        </CardHeader>
        {me?.checklistDismissedAt ? (
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              className="focus-visible:ring-ring/40 gap-2"
              onClick={() => saveMutation.mutate({ checklistDismissed: false })}
              disabled={saveMutation.isPending}
              data-testid="welcome-restore"
            >
              {saveMutation.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-4" aria-hidden="true" />
              )}
              {t("welcomeCardRestore")}
            </Button>
          </CardContent>
        ) : null}
      </Card>

      {/* Prompt 28 — platform console entry. Rendered ONLY when the server
          says this user is a platform operator (§16): tenants never see the
          entry point, and the entry itself is verified again server-side.
          R65 — an operator gated by the MFA policy does NOT get the entry
          here either; the console itself offers enrollment. */}
      {operatorSelf ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="text-primary size-4" aria-hidden="true" />
              {t("platformCardTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("platformCardDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => useAppStore.getState().navigate({ kind: "platform", section: "overview" })}
            >
              <Activity className="size-4" aria-hidden="true" />
              {t("platformCardOpen")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="text-primary size-4" aria-hidden="true" />
            {tLegal("title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {tLegal("description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {legalDocsError ? (
            <p className="text-muted-foreground text-sm">{tLegal("loadError")}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium">{tLegal("currentVersions")}</p>
              <ul className="divide-y rounded-md border text-sm">
                {(legalDocs ?? []).map((d) => (
                  <li key={d.documentType} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="font-medium">
                      {d.documentType === "terms"
                        ? tLegal("termsLabel")
                        : d.documentType === "privacy"
                          ? tLegal("privacyLabel")
                          : d.documentType === "ai-data-use"
                            ? tLegal("aiDataUseLabel")
                            : tLegal("cookiesLabel")}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-muted-foreground text-xs" dir="ltr">
                        v{d.version}
                      </span>
                      <a
                        href={d.documentType === "ai-data-use" ? "/ai-data-use" : `/${d.documentType}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary text-xs underline-offset-4 hover:underline"
                      >
                        {tLegal("openDoc")}
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-medium">{tLegal("acceptancesTitle")}</p>
            {(legalAcceptances ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">{tLegal("noAcceptances")}</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {(legalAcceptances ?? []).map((a) => (
                  <li key={`${a.documentType}-${a.documentVersion}-${a.acceptedAt}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="font-medium">
                      {a.documentType === "terms" ? tLegal("termsLabel") : tLegal("privacyLabel")}
                    </span>
                    <span className="text-muted-foreground text-xs" dir="ltr">
                      v{a.documentVersion} · {new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
                        dateStyle: "medium",
                      }).format(new Date(a.acceptedAt))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-muted-foreground text-xs">
            {tLegal("privacyContact")}:{" "}
            <a
              href="/privacy#contact-details"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              {tLegal("privacyLabel")}
            </a>
          </p>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2 text-base">
            <TriangleAlert className="size-4" aria-hidden="true" />
            {tAuth("deleteAccountTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {tAuth("deleteAccountDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-destructive bg-destructive/10 flex items-start gap-1.5 rounded-md px-3 py-2 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {tAuth("deleteAccountDescBusinesses")}
          </p>
          <div className="space-y-2">
            <Label htmlFor="delete-password">{tAuth("password")}</Label>
            <Input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              dir="ltr"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="delete-confirmation">{tAuth("deleteAccountConfirmLabel")}</Label>
            <Input
              id="delete-confirmation"
              autoComplete="off"
              dir="ltr"
              placeholder={deleteConfirmWord}
              maxLength={20}
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="destructive"
            className="gap-2"
            disabled={!deleteGated || deleteAccountMutation.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            <TriangleAlert className="size-4" aria-hidden="true" />
            {tAuth("deleteAccountConfirmButton")}
          </Button>
        </CardContent>
      </Card>

      {/* Final confirmation — destructive AlertDialog; server errors
          (including the owned-business block) surface inside the dialog. */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) {
            deleteAccountMutation.reset();
            setDeleteError(null);
            setOwnedBlocked(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tAuth("deleteAccountTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tAuth("deleteAccountDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          {ownedBlocked && ownedBlocked.length > 0 ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert">
              <p>{tAuth("deleteAccountBlocked")}</p>
              <ul className="mt-1.5 list-disc space-y-0.5 ps-5">
                {ownedBlocked.map((b) => (
                  <li key={b.id} className="font-medium">
                    {b.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : deleteError ? (
            <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              disabled={deleteAccountMutation.isPending}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the DELETE resolves
                deleteAccountMutation.mutate();
              }}
            >
              {deleteAccountMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <TriangleAlert className="size-4" aria-hidden="true" />
              )}
              {tAuth("deleteAccountConfirmButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

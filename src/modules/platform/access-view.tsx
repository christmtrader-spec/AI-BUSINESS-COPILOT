"use client";

/**
 * R67 — Access matrix view (§9 "role-permission read-only matrix").
 *
 * ZERO hardcoded matrix data: every role, permission, policy value and
 * enabled-cell comes from the live GET /platform/access query, which the
 * server derives from the ACTUAL RBAC registry (§81 — the same constants
 * the authorization chain enforces). The view adds presentation only:
 * search, domain filter and a "write only" toggle over the server rows.
 *
 * Honesty laws: the MFA-enforcement chip shows the raw server enum value
 * (never a client-side claim), the wildcard chip states "none" because the
 * server reports wildcardPermissions=false (deny-by-default catalog), and
 * the row counter reflects the CURRENT filter honestly.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check, Crown, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  ListSkeleton,
  PLATFORM_BRAND_BADGE,
  PLATFORM_GRADIENT_SOFT,
  formatCount,
} from "./kit";
import { platformQueries, type PlatformAccessInfo } from "./platform-api";

export function AccessView() {
  const t = useTranslations("platform");
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["platform", "access"],
    queryFn: () => platformQueries.access(),
    refetchOnWindowFocus: false,
  });

  const [search, setSearch] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [writeOnly, setWriteOnly] = React.useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <AccessHeader info={null} />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-4">
        <AccessHeader info={null} />
        <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />
      </div>
    );
  }

  const permissions = data.permissions;
  const domains = uniqueInOrder(permissions.map((p) => p.domain));
  const q = search.trim().toLowerCase();
  const filtered = permissions.filter(
    (p) =>
      (!q || p.id.toLowerCase().includes(q)) &&
      (!domain || p.domain === domain) &&
      (!writeOnly || p.write),
  );
  const groups = groupByDomain(filtered);

  return (
    <div className="space-y-4" data-testid="pf-acc-page">
      <AccessHeader info={data} />

      {/* Role cards — one per server role, in the server's canonical order. */}
      <section aria-label={t("access.rolesHeading")} data-testid="pf-acc-roles">
        <h3 className="mb-2 text-sm font-semibold">{t("access.rolesHeading")}</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {data.roles.map((r) => (
            <Card key={r.role} className="py-0" data-testid="pf-acc-role-card">
              <CardContent className="space-y-2 p-3">
                <div className="flex items-center gap-1.5">
                  {r.isSuper ? (
                    <Crown className="text-[#a13fd6] dark:text-[#C165DD] size-4 shrink-0" aria-hidden="true" />
                  ) : null}
                  <span className="truncate text-sm font-medium">
                    {t(`roles.${r.role}` as Parameters<typeof t>[0])}
                  </span>
                </div>
                <p className="text-muted-foreground text-xs tabular-nums">
                  {t("access.permCount", { count: r.permissionCount })}
                </p>
                <div className="flex flex-wrap gap-1">
                  {r.mfaRequired ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400 gap-1"
                      data-testid="pf-acc-role-mfa"
                    >
                      <ShieldCheck className="size-3" aria-hidden="true" />
                      {t("access.mfaRequired")}
                    </Badge>
                  ) : null}
                  {r.isSuper ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      {t("access.superRole")}
                    </Badge>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Filters + honest row count. */}
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="pf-acc-search">{t("access.searchLabel")}</Label>
            <Input
              id="pf-acc-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="platform:pricing:manage"
              dir="ltr"
              className="font-mono text-xs"
              data-testid="pf-acc-search"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-acc-domain">{t("access.domainFilter")}</Label>
            <Select
              value={domain || "ALL"}
              onValueChange={(v) => setDomain(v === "ALL" ? "" : v)}
            >
              <SelectTrigger id="pf-acc-domain" aria-label={t("access.domainFilter")} className="w-full" data-testid="pf-acc-domain">
                <SelectValue placeholder={t("access.domainAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("access.domainAll")}</SelectItem>
                {domains.map((d) => (
                  <SelectItem key={d} value={d}>
                    <span className="font-mono text-xs" dir="ltr">
                      {d}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="text-muted-foreground flex items-center gap-2 self-end text-xs">
            <input
              type="checkbox"
              checked={writeOnly}
              onChange={(e) => setWriteOnly(e.target.checked)}
              className="accent-foreground size-3.5"
              data-testid="pf-acc-write-only"
            />
            {t("access.writeOnly")}
          </label>
          <div className="flex items-end justify-between gap-2 lg:justify-end">
            <p className="text-muted-foreground text-xs tabular-nums" data-testid="pf-acc-count">
              {t("access.shownCount", { shown: filtered.length, total: permissions.length })}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
              {t("access.refresh")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState label={t("access.empty")} />
      ) : (
        <>
          {/* Desktop matrix — sticky first column + sticky thead inside a
              bounded scroll area; the corner cell stacks both stickies. */}
          <div
            className="border-border/60 hidden max-h-[60vh] overflow-auto rounded-md border md:block"
            data-testid="pf-acc-matrix"
          >
            <Table>
              <TableHeader className="sticky top-0 z-20 bg-background">
                <TableRow>
                  <TableHead className="bg-background sticky start-0 z-30 min-w-56">
                    {t("access.colPermission")}
                  </TableHead>
                  {data.roles.map((r) => (
                    <TableHead key={r.role} className="text-center">
                      {t(`roles.${r.role}` as Parameters<typeof t>[0])}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map(([dom, rows]) => (
                  <React.Fragment key={dom}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell
                        colSpan={data.roles.length + 1}
                        className="py-1.5"
                      >
                        <span className="font-mono text-xs font-semibold" dir="ltr">
                          {dom}
                        </span>
                      </TableCell>
                    </TableRow>
                    {rows.map((p) => (
                      <TableRow key={p.id} data-testid="pf-acc-row">
                        <TableCell className="sticky start-0 z-10 bg-background">
                          <span
                            className="font-mono text-xs"
                            dir="ltr"
                            title={p.id}
                          >
                            {p.id}
                          </span>
                        </TableCell>
                        {data.roles.map((r) => {
                          const enabled = p.roles.includes(r.role);
                          return (
                            <TableCell
                              key={r.role}
                              className="text-center"
                              title={p.id}
                              data-testid="pf-acc-cell"
                            >
                              {enabled ? (
                                <Check
                                  className="text-foreground mx-auto size-4"
                                  aria-label={t("access.granted")}
                                  role="img"
                                />
                              ) : (
                                <span
                                  className="text-muted-foreground/50 text-xs"
                                  aria-label={t("access.denied")}
                                >
                                  —
                                </span>
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile (390px) — one card per permission, role chips instead of
              the grid; same data, no horizontal scrolling. */}
          <div className="space-y-2 md:hidden" data-testid="pf-acc-cards">
            {groups.map(([dom, rows]) => (
              <div key={dom} className="space-y-2">
                <p className="text-muted-foreground font-mono text-xs font-semibold" dir="ltr">
                  {dom}
                </p>
                {rows.map((p) => (
                  <div key={p.id} className="rounded-md border p-3" data-testid="pf-acc-card">
                    <p className="font-mono text-xs break-all" dir="ltr">
                      {p.id}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {data.roles.map((r) =>
                        p.roles.includes(r.role) ? (
                          <Badge key={r.role} variant="outline" className="gap-1">
                            <Check className="size-3" aria-hidden="true" />
                            {t(`roles.${r.role}` as Parameters<typeof t>[0])}
                          </Badge>
                        ) : null,
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------ header + policy ---------------------------- */

function AccessHeader({ info }: { info: PlatformAccessInfo | null }) {
  const t = useTranslations("platform");
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("access.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("access.description")}</p>
      </div>
      {/* Purple policy strip — every value is the server's own (raw enum in
          mono; nothing restated client-side). */}
      <div
        className={`border-[#C165DD]/30 ${PLATFORM_GRADIENT_SOFT} flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border p-3`}
        data-testid="pf-acc-policy"
      >
        {info ? (
          <>
            <PolicyChip
              label={t("access.policyMfa")}
              value={info.policy.mfaEnforcement}
              mono
              testid="pf-acc-policy-mfa"
            />
            <PolicyChip
              label={t("access.policyWildcard")}
              value={t("access.policyWildcardValue")}
              testid="pf-acc-policy-wildcard"
            />
            <PolicyChip
              label={t("access.policyInviteTtl")}
              value={t("access.policyInviteTtlValue", { hours: info.policy.inviteTtlHours })}
              testid="pf-acc-policy-invite"
            />
            <PolicyChip
              label={t("access.policyApprovals")}
              value={formatCount(info.policy.approvalKinds.length)}
              testid="pf-acc-policy-approvals"
            />
          </>
        ) : (
          <span className="text-muted-foreground text-xs">{t("access.policyTitle")}</span>
        )}
      </div>
    </div>
  );
}

function PolicyChip({
  label,
  value,
  mono,
  testid,
}: {
  label: string;
  value: string;
  mono?: boolean;
  testid: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs" data-testid={testid}>
      <span className="text-muted-foreground">{label}:</span>
      <span
        className={`${PLATFORM_BRAND_BADGE} rounded-md border px-1.5 py-0.5 font-medium ${mono ? "font-mono" : ""}`}
        dir={mono ? "ltr" : undefined}
      >
        {value}
      </span>
    </span>
  );
}

/* -------------------------------- helpers ---------------------------------- */

/** Unique values in first-appearance order (server catalog order preserved). */
function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

/** Filtered rows grouped by domain, domain order = first appearance. */
function groupByDomain(rows: PlatformAccessInfo["permissions"]): Array<[string, PlatformAccessInfo["permissions"]]> {
  const map = new Map<string, PlatformAccessInfo["permissions"]>();
  for (const p of rows) {
    const list = map.get(p.domain);
    if (list) list.push(p);
    else map.set(p.domain, [p]);
  }
  return [...map.entries()];
}

"use client";

/**
 * Platform console API layer — Prompt 28.
 *
 * Deliberately separate from the tenant `api()` helper: platform calls
 * never carry the x-business-id header (businessId is NOT a platform
 * authorization key, §11) and never get prefetched for tenant users
 * (§16) — the only call every authenticated user makes is the capability
 * probe (/self), and only once after sign-in.
 *
 * Every mutation body that requires it carries the operator's CURRENT
 * PASSWORD for reauthentication (§56) — the password lives in memory for
 * the duration of the request only and is never stored or logged.
 */
import { ApiClientError } from "@/lib/api-client";

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export async function platformApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "Network error. Please try again.", 0);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const envelope = body as Envelope<T> | null;
  if (!res.ok || !envelope || envelope.ok === false) {
    const err = envelope && envelope.ok === false ? envelope.error : null;
    throw new ApiClientError(
      err?.code ?? "HTTP_ERROR",
      err?.message ?? "Request failed.",
      res.status,
      err?.details,
    );
  }
  return envelope.data;
}

/* --------------------------------- types ---------------------------------- */

export type PlatformSelf = {
  isOperator: true;
  operatorId: string;
  /** R65 (§5.1) — the shell shows the operator identity in the account menu. */
  email: string;
  role: string;
  permissions: string[];
  /** R65 (§6.2) — the operator's OWN MFA status; drives the identity chip + gate. */
  mfaEnabled: boolean;
};

export type PageMeta = {
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type PlatformOverview = {
  generatedAt: string;
  windowDays: number;
  users: number;
  businesses: number;
  activeOperators: number;
  subscriptions: {
    byStatus: Record<string, number>;
    byPlan: Record<string, number>;
    trialing: number;
    active: number;
    canceled: number;
    expired: number;
    paused: number;
    pastDue: number;
  };
  payments: { pendingCheckouts: number; reconciliationRequired: number; transactionsTotal: number };
  ai: {
    requestsWindow: number;
    knownRecords: number;
    unknownRecords: number;
    costCoverageBps: number | null;
    openAnomalies: number;
    knownCostNanoMinorByCurrency: Record<string, string> | null;
    guardStatus: string | null;
  };
  trust: {
    readinessBlockers: Array<{ key: string; status: string }>;
    verdict: string;
  };
  /** Prompt 62 §7.2 — support-desk counters (server-derived, unresolved set). */
  support: {
    open: number;
    awaitingFirstResponse: number;
    urgentOpen: number;
    /** R64 — open unanswered tickets past the 4h first-response SLA. */
    slaOverdue: number;
  };
  /** Prompt 63 — Security Center counters (window = windowDays). */
  security: { loginsWindow: number; failedLoginsWindow: number; suspendedUsers: number };
};

export type PlatformBusiness = {
  id: string;
  name: string;
  slug: string;
  currencyCode: string;
  locale: string;
  timezone: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PlatformBusinessDetail = {
  business: PlatformBusiness;
  subscription: {
    id: string;
    status: string;
    billingPeriod: string;
    planCode: string;
    planName: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    trialStart: string | null;
    trialEnd: string | null;
  } | null;
  usage: { totalMeteredUnits: number; usageEvents: number };
  payments: Array<{
    id: string;
    provider: string;
    status: string;
    amountMinor: number;
    currency: string;
    processedAt: string;
  }>;
  aiCost: {
    knownRecords: number;
    unknownRecords: number;
    costCoverageBps: number | null;
    knownCostNanoMinorByCurrency: Record<string, string>;
  } | null;
};

export type PlatformUser = {
  id: string;
  name: string | null;
  email: string;
  locale: string;
  createdAt: string;
  updatedAt: string;
  sessionVersion: number;
  ownedBusinessCount: number;
  membershipCount: number;
  isPlatformOperator: boolean;
  suspendedAt: string | null;
};

/* --------------------- Prompt 62 — Support Center (§10) -------------------- */

export type PlatformSupportTicket = {
  id: string;
  number: number;
  reference: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  requesterEmail: string;
  requesterName: string | null;
  businessName: string | null;
  businessId: string | null;
  assigneeOperatorId: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  /**
   * R64 — first-response SLA verdict: met = operator responded; due_soon /
   * overdue = unanswered open ticket aging past 3h/4h; open = fresh; na =
   * resolved/closed with no response ever.
   */
  sla: "met" | "due_soon" | "overdue" | "open" | "na";
};

export type PlatformSupportMessage = {
  id: string;
  authorKind: string;
  authorName: string | null;
  visibility: string;
  body: string;
  createdAt: string;
};

export type PlatformTicketDiagnostics = {
  subscription: {
    status: string;
    planName: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
  } | null;
  requester: {
    totalTickets: number;
    recentTickets: Array<{ id: string; number: number; subject: string; status: string; createdAt: string }>;
  };
  failedDeliveries: Array<{
    notificationType: string;
    channel: string;
    status: string;
    failureCode: string | null;
    createdAt: string;
  }>;
  securityEvents: Array<{ eventType: string; success: boolean; createdAt: string }> | null;
  recentTargetedAudit: Array<{ action: string; createdAt: string; operatorRole: string | null }> | null;
  windows: { diagnosticsLimit: number };
};

export type PlatformSupportTicketDetail = PlatformSupportTicket & {
  description: string;
  resolutionSummary: string | null;
  closedAt: string | null;
  assigneeRole: string | null;
  allowedTransitions: string[];
  messages: PlatformSupportMessage[];
};

export type PlatformTicketViewer = {
  operatorId: string;
  canAssign: boolean;
  canUpdate: boolean;
  canResolve: boolean;
};

export type PlatformSubscription = {
  id: string;
  businessId: string;
  businessName: string;
  status: string;
  billingPeriod: string;
  planCode: string;
  planName: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformPayment = {
  kind: "checkout_session" | "payment_transaction" | "processed_webhook_event";
  id: string;
  checkoutSessionId?: string;
  businessId: string | null;
  businessName: string | null;
  planCode: string | null;
  provider: string;
  providerRef?: string | null;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  reconciliationReason?: string | null;
  initiatedByEmail?: string | null;
  processedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
};

export type PlatformPriceBook = {
  id: string;
  code: string;
  version: string;
  currency: string;
  active: boolean;
  currentlyEffective: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  description: string;
  prices: Array<{ planCode: string; billingPeriod: string; amountMinor: number; active: boolean }>;
};

export type PlatformAiCostRate = {
  id: string;
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputRateNanoMinorPer1K: string;
  outputRateNanoMinorPer1K: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  environment: string;
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
  hasSourceReference: boolean;
  createdAt: string;
};

export type PlatformAiCostRecord = {
  id: string;
  businessId: string;
  requestId: string;
  planCodeAtUsage: string;
  provider: string;
  model: string;
  currency: string | null;
  rateVersion: string | null;
  environment: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenStatus: string;
  costStatus: string;
  costNanoMinor: string | null;
  costDisplayMinor: string | null;
  unknownReason: string | null;
  createdAt: string;
};

export type PlatformAiCostAnomaly = {
  id: string;
  type: string;
  severity: string;
  businessId: string | null;
  provider: string | null;
  model: string | null;
  windowStart: string;
  windowEnd: string;
  metric: string;
  baseline: string | null;
  currentValue: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformAuditEntry = {
  id: string;
  operatorId: string | null;
  operatorRole: string | null;
  operatorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  targetUserId: string | null;
  targetBusinessId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ip: string | null;
  createdAt: string;
};

/* ---------------- Prompt 63 — Security Center (ورود و خروج) ---------------- */

export type PlatformSecuritySummary = {
  generatedAt: string;
  logins24h: number;
  failedLogins24h: number;
  rateLimitedLogins24h: number;
  mfaFailures24h: number;
  sessionRevocations7d: number;
  suspendedUsers: number;
  activeOperators: number;
  activeSessions: number;
  /** R64 — failed-login storm buckets (email or hashed-IP) in the last 60 min, threshold ≥5. */
  failedLoginBursts1h: number;
  /** R65 (§5.1) — active operator rows whose user has NO MFA enabled. */
  activeOperatorsWithoutMfa: number;
  /** R65 (§10) — approval requests currently awaiting a second person. */
  pendingApprovalRequests: number;
  eventTypes24h: Record<string, number>;
};

export type PlatformSecurityEvent = {
  id: string;
  eventType: string;
  success: boolean;
  reasonCode: string | null;
  email: string | null;
  userAgent: string | null;
  ipHashPrefix: string | null;
  createdAt: string;
};

/**
 * R64 — failed-login burst detail (GET /security/anomalies). The
 * identity-bearing companion of the COUNT-only summary: emails and the SAME
 * 12-hex IP prefixes the events feed already shows, grouped over the sliding
 * window. Server owns window/threshold constants — the client never tunes them.
 */
export type PlatformSecurityAnomalies = {
  generatedAt: string;
  windowMinutes: number;
  threshold: number;
  emailBursts: Array<{ key: string; count: number; lastAt: string }>;
  ipBursts: Array<{ key: string; count: number; lastAt: string }>;
  totalBursts: number;
};

/** R64 — one row of the operator session registry (GET /operators/[id]/sessions). */
export type PlatformOperatorSession = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt: string | null;
  /** Server-computed: not revoked AND not expired. */
  live: boolean;
  ipHashPrefix: string | null;
};

export type PlatformOperatorSessions = {
  operator: { id: string; email: string | null; name: string | null; role: string; active: boolean };
  activeCount: number;
  sessions: PlatformOperatorSession[];
  truncated: boolean;
};

export type PlatformOperator = {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/* ------------- R67 — operator invitations ("admin registration") ---------- */

export const PLATFORM_INVITE_STATUSES = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"] as const;

/** Mirrors the server's operatorInviteDto() — the token NEVER appears in a
 * list DTO (§14: the token IS a credential, disclosed exactly once). */
export type PlatformOperatorInvite = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: (typeof PLATFORM_INVITE_STATUSES)[number] | string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  createdBy: { name: string | null; email: string } | null;
  acceptedByAccount: { email: string } | null;
};

/** POST /operators/invites 201 — the ONE-TIME disclosure payload (§60): the
 * opaque token + a ready-made redemption link, shown once to the inviter. */
export type PlatformInviteCreateResult = {
  invite: PlatformOperatorInvite;
  token: string;
  redemptionUrl: string;
  expiresInHours: number;
  requestId: string;
};

/** GET /platform/invites/[token] — anonymous redemption preview (§161:
 * the token IS the authorization). accountExists binds the password field
 * semantics (set initial vs prove control). */
export type PlatformInvitePreview = {
  invite: {
    email: string;
    name: string;
    role: string;
    status: (typeof PLATFORM_INVITE_STATUSES)[number] | string;
    expiresAt: string;
    inviter: { name: string | null; email: string } | null;
    accountExists: boolean;
  };
};

/* ----------------------- R67 — access matrix (§9) -------------------------- */

/** GET /platform/access — every value derives from the ACTUAL server RBAC
 * registry (§81); the client renders it verbatim and hardcodes NOTHING. */
export type PlatformAccessInfo = {
  roles: Array<{ role: string; permissionCount: number; isSuper: boolean; mfaRequired: boolean }>;
  permissions: Array<{
    id: string;
    domain: string;
    scope: string;
    write: boolean;
    sensitive: boolean;
    reauthRequired: boolean;
    roles: string[];
  }>;
  policy: {
    mfaEnforcement: string;
    approvalKinds: string[];
    inviteTtlHours: number;
    wildcardPermissions: boolean;
  };
};

export type PlatformSystem = {
  generatedAt: string;
  components: Array<{ key: string; status: string; detail: string | null }>;
};

/* ------------ Prompt 65 — two-person approval (§10, R65-UI) ---------------- */

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Mirrors the server's approvalDto() (src/lib/platform/approvals.ts). */
export type PlatformApproval = {
  id: string;
  kind: string;
  /** Server-bounded English description (e.g. "Activate price book <id>"). */
  kindLabel: string;
  /** e.g. { priceBookId } for pricing.activate. */
  payload: Record<string, unknown> | null;
  /** 12-hex correlation prefix of the SHA-256 payload hash. */
  payloadHashPrefix: string;
  reason: string;
  status: ApprovalStatus | string;
  requester: { id: string; email: string | null; role: string; active: boolean } | null;
  approver: { id: string; email: string | null; role: string; active: boolean } | null;
  approvalNote: string | null;
  rejectionReason: string | null;
  expiresAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  /** Value-free error code only (sanitized server-side) — never raw text. */
  executeError: string | null;
  createdAt: string;
};

/* --------------------------------- calls ---------------------------------- */

export const platformQueries = {
  self: () => platformApi<PlatformSelf>("/api/v1/platform/self"),
  overview: () => platformApi<PlatformOverview>("/api/v1/platform/overview"),
  businesses: (params: string) =>
    platformApi<{ businesses: PlatformBusiness[]; page: PageMeta }>(
      `/api/v1/platform/businesses${params ? `?${params}` : ""}`,
    ),
  business: (id: string) =>
    platformApi<PlatformBusinessDetail>(`/api/v1/platform/businesses/${id}`),
  users: (params: string) =>
    platformApi<{ users: PlatformUser[]; page: PageMeta }>(
      `/api/v1/platform/users${params ? `?${params}` : ""}`,
    ),
  supportTickets: (params: string) =>
    platformApi<{
      tickets: PlatformSupportTicket[];
      page: PageMeta;
      facets: { statuses: string[]; priorities: string[]; categories: string[] };
    }>(`/api/v1/platform/support/tickets${params ? `?${params}` : ""}`),
  supportTicket: (id: string) =>
    platformApi<{
      ticket: PlatformSupportTicketDetail;
      diagnostics: PlatformTicketDiagnostics;
      viewer: PlatformTicketViewer;
    }>(`/api/v1/platform/support/tickets/${id}`),
  subscriptions: (params: string) =>
    platformApi<{ subscriptions: PlatformSubscription[]; page: PageMeta }>(
      `/api/v1/platform/subscriptions${params ? `?${params}` : ""}`,
    ),
  payments: (params: string) =>
    platformApi<{
      items: PlatformPayment[];
      counts: { checkoutSessions: number; transactions: number; webhookEvents: number };
      page: PageMeta;
    }>(`/api/v1/platform/payments${params ? `?${params}` : ""}`),
  pricing: () =>
    platformApi<{
      books: PlatformPriceBook[];
      currencyCoverage: Array<{ currency: string; activeBook: boolean }>;
    }>("/api/v1/platform/pricing"),
  aiCostOverview: (windowDays: number) =>
    platformApi<{
      health: {
        windowDays: number;
        knownCostNanoMinorByCurrency: Record<string, string>;
        knownRecords: number;
        unknownRecords: number;
        costCoverageBps: number;
        tokenCoverageBps: number;
        completeTokenUsageEvents: number;
        aiUsageEvents: number;
        verifiedRates: number;
        unverifiedRates: number;
        openAnomalies: number;
        guardStatus: string;
      };
      breakdown: {
        byProvider: Array<{ key: string; knownCostNanoMinorByCurrency: Record<string, string>; knownRecords: number; unknownRecords: number; requests: number; tokens: string; coverageBps: number }>;
        byModel: Array<{ key: string; knownCostNanoMinorByCurrency: Record<string, string>; knownRecords: number; unknownRecords: number; requests: number; tokens: string; coverageBps: number }>;
        byPlan: Array<{ key: string; knownCostNanoMinorByCurrency: Record<string, string>; knownRecords: number; unknownRecords: number; requests: number; tokens: string; coverageBps: number }>;
        byBusiness: Array<{ key: string; knownCostNanoMinorByCurrency: Record<string, string>; knownRecords: number; unknownRecords: number; requests: number; tokens: string; coverageBps: number }>;
      };
      unknownGroups: {
        windowDays: number;
        groups: Array<{ provider: string; model: string; reason: string | null; planCode: string; businessId: string; count: number }>;
      };
    }>(`/api/v1/platform/ai-cost/overview?windowDays=${windowDays}`),
  aiRates: (params: string) =>
    platformApi<{ rates: PlatformAiCostRate[]; page: PageMeta }>(
      `/api/v1/platform/ai-cost/rates${params ? `?${params}` : ""}`,
    ),
  aiLedger: (params: string) =>
    platformApi<{ records: PlatformAiCostRecord[]; page: PageMeta }>(
      `/api/v1/platform/ai-cost/ledger${params ? `?${params}` : ""}`,
    ),
  aiEconomics: (planCode: string, billingPeriod: string) =>
    platformApi<{
      economics: {
        planCode: string;
        billingPeriod: string;
        status: string;
        priceMinor: number | null;
        priceCurrency: string | null;
        knownCostNanoMinorByCurrency: Record<string, string>;
        costCurrency: string | null;
        contributionMinor: number | null;
        contributionMarginBps: number | null;
        sampleSize: number;
        costCoverageBps: number;
        negativeContribution: boolean;
        label: string;
      };
    }>(`/api/v1/platform/ai-cost/economics?planCode=${planCode}&billingPeriod=${billingPeriod}`),
  aiAnomalies: (params: string) =>
    platformApi<{ anomalies: PlatformAiCostAnomaly[]; page: PageMeta }>(
      `/api/v1/platform/ai-cost/anomalies${params ? `?${params}` : ""}`,
    ),
  aiReconcile: (body: { mode: "dry-run" | "apply"; reason: string; confirmation?: string; password?: string }) =>
    platformApi<{
      report: {
        mode: string;
        candidateRecordCount: number;
        eligibleRecords: number;
        rateFound: number;
        rateMissing: number;
        tokenComplete: number;
        tokenIncomplete: number;
        currencyMismatch: number;
        conflicts: number;
        alreadyKnown: number;
        wouldUpdateCount: number;
        updatedCount: number;
        boundedWindow: { from: string; to: string };
      };
      requestId: string;
    }>("/api/v1/platform/ai-cost/reconciliation", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  audit: (params: string) =>
    platformApi<{ entries: PlatformAuditEntry[]; page: PageMeta }>(
      `/api/v1/platform/audit${params ? `?${params}` : ""}`,
    ),
  securitySummary: () =>
    platformApi<PlatformSecuritySummary>("/api/v1/platform/security/summary"),
  securityEvents: (params: string) =>
    platformApi<{ events: PlatformSecurityEvent[]; page: PageMeta; facets: { eventTypes: string[] } }>(
      `/api/v1/platform/security/events${params ? `?${params}` : ""}`,
    ),
  securityAnomalies: () =>
    platformApi<PlatformSecurityAnomalies>("/api/v1/platform/security/anomalies"),
  operators: (params: string) =>
    platformApi<{ operators: PlatformOperator[]; page: PageMeta }>(
      `/api/v1/platform/operators${params ? `?${params}` : ""}`,
    ),
  operatorSessions: (operatorId: string) =>
    platformApi<PlatformOperatorSessions>(`/api/v1/platform/operators/${operatorId}/sessions`),
  operatorInvites: (params: string) =>
    platformApi<{ invites: PlatformOperatorInvite[]; page: PageMeta }>(
      `/api/v1/platform/operators/invites${params ? `?${params}` : ""}`,
    ),
  access: () => platformApi<PlatformAccessInfo>("/api/v1/platform/access"),
  approvals: (params: string) =>
    platformApi<{ approvals: PlatformApproval[]; meta: PageMeta; kinds: string[] }>(
      `/api/v1/platform/approvals${params ? `?${params}` : ""}`,
    ),
  system: () => platformApi<PlatformSystem>("/api/v1/platform/system"),
};

/** Reauth-required mutations — every one audited server-side (§34/§56). */
export const platformMutations = {
  pauseSubscription: (businessId: string, body: { reason: string; password: string }) =>
    platformApi<{ changed: boolean; requestId: string }>(
      `/api/v1/platform/businesses/${businessId}/subscription/pause`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  resumeSubscription: (businessId: string, body: { reason: string; password: string }) =>
    platformApi<{ changed: boolean; requestId: string }>(
      `/api/v1/platform/businesses/${businessId}/subscription/resume`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  changePlan: (businessId: string, body: { planCode: string; reason: string; password: string }) =>
    platformApi<{ changed: boolean; requestId: string }>(
      `/api/v1/platform/businesses/${businessId}/subscription/plan`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  trial: (businessId: string, body: { action: "start" | "end"; reason: string; password: string }) =>
    platformApi<{ changed: boolean; requestId: string }>(
      `/api/v1/platform/businesses/${businessId}/trial`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  invalidateSessions: (userId: string, body: { reason: string; password: string }) =>
    platformApi<{ invalidated: boolean; requestId: string }>(
      `/api/v1/platform/users/${userId}/invalidate-sessions`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  suspendUser: (userId: string, body: { reason: string; password: string }) =>
    platformApi<{ user: { id: string; suspendedAt: string; sessionVersion: number } }>(
      `/api/v1/platform/users/${userId}/suspend`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  reactivateUser: (userId: string, body: { reason: string; password: string }) =>
    platformApi<{ user: { id: string; suspendedAt: null; sessionVersion: number } }>(
      `/api/v1/platform/users/${userId}/reactivate`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Prompt 62 §18 — explicit-recipient system announcement (server caps 50). */
  sendAnnouncement: (body: { recipientUserIds: string[]; message: string }) =>
    platformApi<{ accepted: number; rejected: number }>(
      `/api/v1/platform/notifications/announcements`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  supportPatchTicket: (
    id: string,
    body: { status?: string; priority?: string; assigneeOperatorId?: string | null },
  ) =>
    platformApi<{ ticket: Record<string, unknown> }>(
      `/api/v1/platform/support/tickets/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  supportMessage: (id: string, body: { body: string; visibility: "CUSTOMER" | "INTERNAL" }) =>
    platformApi<{ message: PlatformSupportMessage }>(
      `/api/v1/platform/support/tickets/${id}/messages`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  supportResolve: (id: string, body: { resolutionSummary: string }) =>
    platformApi<{ ticket: { id: string; status: string; resolvedAt: string; resolutionSummary: string } }>(
      `/api/v1/platform/support/tickets/${id}/resolve`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  reverifyPayment: (sessionId: string, body: { reason: string; password: string }) =>
    platformApi<{
      verification: string;
      session: { id: string; status: string; provider: string; reconciliationReason: string | null };
      requestId: string;
    }>(`/api/v1/platform/payments/${sessionId}/reverify`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  recordInvestigation: (
    sessionId: string,
    body: { reason: string; reviewStatus: string; note?: string; password: string },
  ) =>
    platformApi<{ recorded: boolean; requestId: string }>(
      `/api/v1/platform/payments/${sessionId}/investigation`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  createPriceBook: (body: {
    code: string;
    version: string;
    currency: string;
    description?: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    prices: Array<{ planCode: string; billingPeriod: string; amountMinor: number }>;
    reason: string;
    password: string;
  }) =>
    platformApi<{ priceBook: { id: string; code: string; version: string }; requestId: string }>(
      "/api/v1/platform/pricing",
      { method: "POST", body: JSON.stringify(body) },
    ),
  activatePriceBook: (id: string, body: { reason: string; password: string }) =>
    platformApi<{ priceBook: { id: string; active: boolean }; requestId: string }>(
      `/api/v1/platform/pricing/${id}/activate`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  createAiRate: (body: {
    provider: string;
    model: string;
    currency: string;
    version: string;
    inputRateNanoMinorPer1K: string;
    outputRateNanoMinorPer1K: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    environment: "TEST" | "PRODUCTION";
    sourceReference?: string;
    verifiedBy?: string;
    reason: string;
    password: string;
  }) =>
    platformApi<{ rate: PlatformAiCostRate; requestId: string }>(
      "/api/v1/platform/ai-cost/rates",
      { method: "POST", body: JSON.stringify(body) },
    ),
  deactivateAiRate: (id: string, body: { reason: string; password: string }) =>
    platformApi<{ deactivated: boolean; requestId: string }>(
      `/api/v1/platform/ai-cost/rates/${id}/deactivate`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  verifyAiRate: (id: string, body: { verifiedBy: string; sourceReference: string; reason: string; password: string }) =>
    platformApi<{ verified: boolean; requestId: string }>(
      `/api/v1/platform/ai-cost/rates/${id}/verify`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  acknowledgeAnomaly: (id: string, body: { note?: string }) =>
    platformApi<{ acknowledged: boolean; requestId: string }>(
      `/api/v1/platform/ai-cost/anomalies/${id}/acknowledge`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  createOperator: (body: { email: string; role: string; reason: string; password: string }) =>
    platformApi<{ operator: PlatformOperator; requestId: string }>("/api/v1/platform/operators", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateOperator: (
    id: string,
    body: { role?: string; active?: boolean; reason: string; password: string },
  ) =>
    platformApi<{ operator: { id: string; role: string; active: boolean }; requestId: string }>(
      `/api/v1/platform/operators/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  /** R64 — surgical single-session revocation (one device dies, the rest survive). */
  revokeOperatorSession: (
    operatorId: string,
    sessionId: string,
    body: { reason: string; password: string },
  ) =>
    platformApi<{ revoked: boolean; alreadyRevoked: boolean; requestId: string }>(
      `/api/v1/platform/operators/${operatorId}/sessions/${sessionId}`,
      { method: "DELETE", body: JSON.stringify(body) },
    ),
  /** R67 — mint a single-use operator invite (super-only server-side;
   * reauth §56, mandatory audited reason). The response carries the token
   * EXACTLY ONCE — the client must treat it as display-once (§60). */
  createOperatorInvite: (body: {
    email: string;
    name: string;
    role: string;
    reason: string;
    password: string;
  }) =>
    platformApi<PlatformInviteCreateResult>("/api/v1/platform/operators/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** R67 — revoke a pending invite (idempotent server-side §210). */
  revokeOperatorInvite: (inviteId: string, body: { reason: string; password: string }) =>
    platformApi<{ revoked: boolean; alreadyRevoked: boolean; requestId: string }>(
      `/api/v1/platform/operators/invites/${inviteId}`,
      { method: "DELETE", body: JSON.stringify(body) },
    ),
  /** R65 §10 — second person approves (requester is refused server-side). */
  approveApproval: (id: string, body: { note?: string }) =>
    platformApi<{ approval: PlatformApproval; requestId: string }>(
      `/api/v1/platform/approvals/${id}/approve`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** R65 §10 — rejection with a MANDATORY audited reason (3..300). */
  rejectApproval: (id: string, body: { reason: string }) =>
    platformApi<{ approval: PlatformApproval; requestId: string }>(
      `/api/v1/platform/approvals/${id}/reject`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** R65 §10 — the REQUESTER withdraws their own still-pending request. */
  cancelApproval: (id: string) =>
    platformApi<{ approval: PlatformApproval; requestId: string }>(
      `/api/v1/platform/approvals/${id}/cancel`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  /** R65 §10/§56 — execute an APPROVED (or retryable FAILED) request; the
   * server 403s without the current password (assertPlatformReauth). */
  executeApproval: (id: string, body: { password: string }) =>
    platformApi<{ approval: PlatformApproval; requestId: string }>(
      `/api/v1/platform/approvals/${id}/execute`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};

/**
 * R65 — self-service session/MFA endpoints the console calls for the
 * operator's OWN account (enrollment from the MFA gate, global sign-out
 * from the identity menu). Same {ok,data} envelope as platform routes, so
 * platformApi() works unchanged; errors arrive as ApiClientError with the
 * documented codes (INVALID_CURRENT_PASSWORD, MFA_REAUTH_REQUIRED,
 * MFA_ALREADY_ENABLED, MFA_NOT_CONFIGURED, MFA_INVALID_CODE, RATE_LIMITED).
 */
export const platformSelfService = {
  /** Step-up reauthentication (§116) — opens the recent-password window. */
  reauth: (body: { password: string }) =>
    platformApi<{ passwordVerified: boolean; mfaVerified: boolean; windowSeconds: number }>(
      "/api/v1/me/security/reauth",
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Begin TOTP enrollment — secret/QR returned ONCE (§40). */
  mfaSetupStart: () =>
    platformApi<{ otpauthUri: string; manualKey: string; qrDataUri: string }>(
      "/api/v1/me/security/mfa/setup/start",
      { method: "POST", body: "{}" },
    ),
  /** Verify the first code and enable MFA — recovery codes returned ONCE.
   * Enabling kills ALL sessions server-side (§363). */
  mfaSetupConfirm: (body: { code: string; confirmedSaved: true }) =>
    platformApi<{ enabled: boolean; recoveryCodes: string[]; sessionsInvalidated: boolean }>(
      "/api/v1/me/security/mfa/setup/confirm",
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Sign out every OTHER device (§80) — current session survives; the shell
   * then signs out the current device client-side (best-effort law). */
  revokeAllSessions: (body: { password: string; confirmation: "SIGN OUT ALL" }) =>
    platformApi<{ revokedCount: number; currentSessionKept: boolean }>(
      "/api/v1/me/security/sessions/revoke-all",
      { method: "POST", body: JSON.stringify(body) },
    ),
};

/**
 * R67 — anonymous operator-invite redemption (the #/platform-join/<token>
 * page, rendered OUTSIDE the auth gate). Same {ok,data} envelope as every
 * other route so platformApi() works unchanged — the route itself does NOT
 * require a platform session (the opaque token IS the authorization §161).
 * GET previews role/inviter/expiry/accountExists; POST redeems exactly once
 * (new account → initial password; existing account → CURRENT password,
 * which is NEVER changed by redemption).
 */
export const platformJoinService = {
  preview: (token: string) =>
    platformApi<PlatformInvitePreview>(
      `/api/v1/platform/invites/${encodeURIComponent(token)}`,
    ),
  redeem: (token: string, body: { password: string }) =>
    platformApi<{ accepted: boolean; role: string; accountCreated: boolean }>(
      `/api/v1/platform/invites/${encodeURIComponent(token)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};

/**
 * R64 — raw CSV export for the security events feed. Unlike platformApi()
 * (JSON envelope only), a SUCCESSFUL export responds with CSV TEXT plus
 * x-export-truncated / x-export-rows headers, so it needs its own reader.
 * Errors still arrive as the standard JSON error envelope → ApiClientError,
 * so every existing error surface (usePlatformErrorText) just works.
 */
export async function exportSecurityEventsCsv(
  params: string,
): Promise<{ csv: string; truncated: boolean; rows: number }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/platform/security/events/export${params ? `?${params}` : ""}`, {
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "Network error. Please try again.", 0);
  }
  if (!res.ok) {
    let err: { code: string; message: string; details?: unknown } | null = null;
    try {
      const body = (await res.json()) as Envelope<unknown> | null;
      err = body && body.ok === false ? body.error : null;
    } catch {
      err = null; // non-JSON failure body — fall through to the generic error
    }
    throw new ApiClientError(
      err?.code ?? "HTTP_ERROR",
      err?.message ?? "Request failed.",
      res.status,
      err?.details,
    );
  }
  const csv = await res.text();
  return {
    csv,
    truncated: res.headers.get("x-export-truncated") === "true",
    rows: Number(res.headers.get("x-export-rows") ?? "0"),
  };
}

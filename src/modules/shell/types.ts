export type BusinessSummary = {
  id: string;
  name: string;
  slug: string;
  currencyCode: string;
  currencySymbol: string;
  decimalPrecision: number;
  locale: string;
  timezone: string;
  // Prompt 52 §F3 — VAT engine configuration.
  vatEnabled?: boolean;
  vatRateBp?: number;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
};

export type BusinessListItem = {
  business: BusinessSummary;
  role: string;
  memberId: string;
};

export type MemberItem = {
  id: string;
  role: string;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  isOwner: boolean;
};

export type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { name: string | null; email: string } | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};

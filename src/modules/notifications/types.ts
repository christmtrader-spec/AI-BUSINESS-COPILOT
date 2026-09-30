/**
 * Client-side DTO mirrors for the notification API (Prompt 32 §189).
 * Deliberately SEPARATE from the server DTO module — the server files are
 * `server-only`; this shape is the contract the API guarantees.
 */
export type NotificationDTO = {
  id: string;
  type: string;
  category: string;
  priority: string;
  severity: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
  action: { labelKey: string; route: string } | null;
  businessName: string | null;
};

export type ListNotificationsResult = {
  items: NotificationDTO[];
  page: number;
  pageSize: number;
  total: number;
};

export type EffectivePreference = {
  notificationType: string;
  channel: "IN_APP" | "EMAIL";
  overridable: boolean;
  mandatory: boolean;
  defaultEnabled: boolean;
  enabled: boolean;
};

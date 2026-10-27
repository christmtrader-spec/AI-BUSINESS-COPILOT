import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const models = [
  "auditLog", "chatMessage", "chatSession", "notification", "customer", "supplier",
  "product", "sale", "saleItem", "expense", "payment", "inventoryAdjustment",
  "inventoryStocktake", "usageEvent", "analyticsEvent", "securityEvent", "userSession",
  "session", "user", "business", "businessMember", "mfaLoginChallenge", "subscription",
  "usageCounter", "usagePeriod", "checkoutSession", "paymentTransaction",
  "processedWebhookEvent", "commercialEvent", "contactLead", "emailVerificationToken",
  "passwordResetToken", "businessInvite", "subscriptionEvent", "planEntitlement",
];
const counts: Array<[string, number | string]> = [];
for (const m of models) {
  try {
    const anyDb = db as unknown as Record<string, { count: () => Promise<number> }>;
    counts.push([m, await anyDb[m].count()]);
  } catch {
    counts.push([m, "n/a"]);
  }
}
counts.sort((a, b) => (typeof b[1] === "number" ? b[1] : 0) - (typeof a[1] === "number" ? a[1] : 0));
for (const [m, c] of counts) console.log(String(c).padStart(9), m);
await db.$disconnect();

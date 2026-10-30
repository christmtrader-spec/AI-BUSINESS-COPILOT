/**
 * scripts/r151-qa-notification-fixture.mjs — R151 live-QA fixture.
 *
 * Seeds ONE BUSINESS_INVENTORY_LOW_STOCK notification for the fresh r136
 * QA persona (the persona whose business ALREADY has 1 low-stock product),
 * carrying the R151 actionRoute "reorder" — so the bell panel's row can be
 * clicked in the live QA and proven to land #/reports?reorder=1. The row
 * is swept with the persona afterwards (the r104 sweep pattern).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EMAIL = process.argv[2];
const BUSINESS_ID = process.argv[3];

if (!EMAIL || !BUSINESS_ID) {
  console.error("usage: node scripts/r151-qa-notification-fixture.mjs <email> <businessId>");
  process.exit(1);
}

const user = await prisma.user.findUnique({ where: { email: EMAIL } });
if (!user) {
  console.error(`user not found: ${EMAIL}`);
  process.exit(1);
}

const n = await prisma.notification.create({
  data: {
    userId: user.id,
    businessId: BUSINESS_ID,
    type: "BUSINESS_INVENTORY_LOW_STOCK",
    category: "BUSINESS",
    priority: "NORMAL",
    severity: "WARNING",
    titleKey: "items.BUSINESS_INVENTORY_LOW_STOCK.title",
    bodyKey: "items.BUSINESS_INVENTORY_LOW_STOCK.body",
    dataJson: JSON.stringify({
      productId: "qa-fixture-product",
      productName: "Lapis Coaster Set",
      sku: null,
      unit: null,
      stockQty: 2,
      lowStockAt: 5,
    }),
    actionRoute: "reorder",
  },
});

console.log(JSON.stringify({ id: n.id, actionRoute: n.actionRoute }));
await prisma.$disconnect();

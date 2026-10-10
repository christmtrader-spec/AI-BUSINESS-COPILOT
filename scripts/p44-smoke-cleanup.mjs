// One-off surgical cleanup of the P44 API smoke residue in the persistent
// dev business (idempotent; leaves the baseline fixture untouched).
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const SKU = "P44-SMOKE";
const bizId = process.argv[2];
const product = await db.product.findFirst({ where: { sku: SKU, businessId: bizId } });
if (!product) { console.log("nothing to clean"); process.exit(0); }
const dispatches = await db.goodsDispatch.findMany({ where: { businessId: bizId, lines: { some: { productId: product.id } } }, select: { id: true, reference: true } });
for (const d of dispatches) {
  await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: d.id } });
  await db.goodsDispatch.delete({ where: { id: d.id } });
  console.log("deleted dispatch", d.reference);
}
await db.inventoryAdjustment.deleteMany({ where: { productId: product.id } });
await db.auditLog.deleteMany({ where: { entityType: "GoodsDispatch", businessId: bizId } });
await db.auditLog.deleteMany({ where: { entityType: "Product", entityId: product.id, action: { in: ["product.create", "product.update"] } } });
await db.product.delete({ where: { id: product.id } });
console.log("cleaned product + adjustments; remaining dispatches:", await db.goodsDispatch.count({ where: { businessId: bizId } }));
await db.$disconnect();

/** R104 one-off: FK-safe sweep of the r102/r103 --keep QA probe books. */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const EMAILS = ["r102-stock-probe@qa.local", "r103-tile-probe@qa.local"];

async function main() {
  for (const email of EMAILS) {
    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      console.log(`${email}: absent`);
      continue;
    }
    const businesses = await db.business.findMany({ where: { ownerId: user.id }, select: { id: true } });
    for (const b of businesses) await db.business.delete({ where: { id: b.id } }); // cascades everything
    await db.user.delete({ where: { id: user.id } });
    console.log(`${email}: swept ${businesses.length} business(es) + user (FK-safe)`);
  }
  process.exit(0);
}
main();

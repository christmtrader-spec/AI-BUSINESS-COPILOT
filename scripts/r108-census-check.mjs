import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const users = await db.user.findMany({ select: { id: true, email: true, name: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
const businesses = await db.business.findMany({ select: { id: true, name: true, ownerId: true, createdAt: true } });
console.log('USERS:', users.map(u => `${u.email} (${u.name || '-'})`));
console.log('BUSINESSES:', businesses.map(b => `${b.name} owner=${users.find(u => u.id === b.ownerId)?.email || b.ownerId.slice(0,8)}`));
await db.$disconnect();

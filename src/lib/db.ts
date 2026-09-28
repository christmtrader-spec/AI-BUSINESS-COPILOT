import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Prompt 29 §30 — production-safe database logging.
 *
 * Development: query + warn + error (query stream is a dev convenience).
 * Production:  warn + error ONLY. `query` logging would (a) flood stdout on
 * a single-node deployment and (b) risk emitting SQL parameters that embed
 * user-controlled or sensitive values. Prisma's `emit: 'event'` is NOT used
 * here — the built-in stdout writer for warn/error is sufficient and never
 * prints query parameters for those levels.
 */
const prismaLogLevel =
  process.env.NODE_ENV === 'production'
    ? (['warn', 'error'] as const)
    : (['query', 'warn', 'error'] as const)

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [...prismaLogLevel],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

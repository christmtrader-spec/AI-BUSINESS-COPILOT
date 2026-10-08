/**
 * Prompt 42 — goods-receipt domain barrel. Server code imports the
 * service/export directly (server-only); client code imports ONLY the
 * pure types/dto/schema modules (§169/§170 — no Prisma in the client
 * bundle, no db import from UI code).
 */
export * from "./types";
export * from "./dto";

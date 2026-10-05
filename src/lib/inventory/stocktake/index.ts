/**
 * Prompt 40 — stocktake domain barrel.
 *
 * CLIENT-SAFE (§118): everything in ./types and ./dto is pure — no Prisma,
 * no db, no server-only imports. The client may import types, constants,
 * transition laws and formatters from here.
 *
 * SERVER-ONLY (§118): ./service imports "server-only" and must NEVER be
 * imported from client code. ./schema is server-side request validation.
 */
export * from "./types";
export * from "./dto";

/**
 * Prompt 41 — purchase-order module barrel.
 *
 * CLIENT-SAFE (§118): everything in ./types and ./dto is pure — no Prisma,
 * no db, no server-only imports. UI modules may import from here.
 *
 * SERVER-ONLY (§118): ./service and ./export import `server-only` and must
 * NEVER be imported from client code. ./schema is server-side zod (request
 * boundary); keep it out of client bundles too.
 */
export * from "./types";
export * from "./dto";

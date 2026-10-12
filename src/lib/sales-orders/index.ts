/**
 * Prompt 45 — Sales Orders public module surface (server + shared).
 * Pure laws and DTOs are client-safe; the service/export modules are
 * server-only and must never be imported from client components.
 */
export * from "./types";
export * from "./dto";

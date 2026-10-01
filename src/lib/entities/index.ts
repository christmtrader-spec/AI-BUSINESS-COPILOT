/**
 * Prompt 34 — entity detail DTO layer barrel (§22).
 * All six detail endpoints map their responses through these mappers —
 * data minimization is explicit and auditable (§87).
 */
export * from "./types";
export * from "./summary";
export * from "./customer";
export * from "./supplier";
export * from "./product";
export * from "./sale";
export * from "./expense";
export * from "./payment";

/**
 * Prompt 37 — ABSENCE-PRESERVING optional field schemas (bug fix).
 *
 * zod's `.nullish().transform((v) => v || null)` MATERIALIZES the key in
 * the parsed output even when the request omitted it: the transform runs
 * on `undefined`, produces `null`, and the key becomes an own property of
 * the parsed object. Any service that distinguishes "field absent (keep
 * the stored value)" from "field explicitly null (clear it)" — which is
 * the standard PATCH contract of every CRM service — therefore observed
 * EVERY field as present and silently wiped stored values (unassigned
 * tasks, cleared dueAt/description/relations) on every unrelated update.
 *
 * `optionalPreserved` keeps the key ABSENT when the request omitted it,
 * while "" / null still normalize to null and real values flow through
 * the wrapped schema for validation. CLIENT-SAFE (pure zod).
 */
import { z } from "zod";

export function optionalPreserved<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (v === undefined ? undefined : v === null || v === "" ? null : v),
    schema.nullish(),
  );
}

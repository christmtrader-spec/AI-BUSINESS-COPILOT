/**
 * Shared .env loader for Prompt 29 operational scripts.
 *
 * Loads KEY=VALUE pairs from the project .env WITHOUT overriding variables
 * that are already present in the process environment (explicit env wins).
 * Never prints or returns secret values — callers only read process.env.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadProjectEnv(envPath = join(ROOT, ".env")) {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue; // explicit env wins
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes (value never echoed anywhere).
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    try {
      process.env[key] = value;
    } catch {
      // Frozen env — ignore.
    }
  }
}

declare const Bun: { plugin: (p: unknown) => void };
/**
 * p29-preload.ts — bun --preload for out-of-process unit runs (Prompt 29
 * harness). The real `server-only` package throws outside a React Server
 * environment; these unit checks import server modules DIRECTLY (by design),
 * so the package is mapped to an empty module for this process only.
 * Production behavior is untouched — this preload exists ONLY for the test
 * runner process (scripts/prompt29-unit.ts).
 */
Bun.plugin({
  name: "p29-server-only-stub",
  setup(build) {
    build.module("server-only", () => ({
      exports: {},
      loader: "object",
    }));
  },
});

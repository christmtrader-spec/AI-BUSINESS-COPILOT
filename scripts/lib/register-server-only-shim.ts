// Bun preload shim: registers a virtual "server-only" module for script
// processes that import server code directly (the guard targets bundler
// contexts, not bun's script runner). Registered via `bun --preload`.
Bun.plugin({
  name: "server-only-shim",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});
export {};

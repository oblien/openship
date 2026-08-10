import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Resolve the app's own `@/*` → `src/*` alias (from tsconfig) so tests can
// import components whose imports use it (e.g. DnsRecordCard → @/components/
// i18n-provider). Mirrors apps/api/vitest.config.ts; defaults otherwise
// unchanged.
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  // tsconfig says `jsx: preserve` (Next compiles it), so esbuild would fall back
  // to the classic transform and need React in scope. Use the automatic runtime,
  // same as the app.
  esbuild: { jsx: "automatic" },
});

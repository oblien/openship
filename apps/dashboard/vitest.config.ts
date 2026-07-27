import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Resolve the app's own `@/*` -> `src/*` alias (from tsconfig) at runtime.
// Vitest does not read tsconfig `paths`, so without this any test doing a
// real value import via `@/...` resolves to nothing at run time even though
// it type-checks fine. Existing tests only reach `@/lib/api` through
// `import type`, which esbuild erases, so this bug was latent - keep the
// alias wired so real (non-type) `@/` imports work in future tests too.
const alias = {
  "@": resolve(__dirname, "src"),
};

export default defineConfig({
  resolve: { alias },
  // tsconfig.json sets `"jsx": "preserve"` for Next's own build pipeline.
  // Vitest's esbuild transform honors that setting too, so without an
  // override esbuild leaves JSX untransformed and any `.tsx` test file is a
  // syntax error. Force the automatic runtime here so component tests work
  // independently of the app's Next/webpack JSX handling.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    // Existing dashboard tests import describe/it/expect explicitly from
    // "vitest" rather than relying on injected globals - keep that
    // convention instead of turning global test APIs on, for every project.
    globals: false,
    // Split by environment instead of one flat `environment: "jsdom"`.
    // Reason: under this Bun + jsdom combination, jsdom's patched global
    // `URL` resolves a relative URL string against jsdom's document location
    // instead of an explicit `file:` base argument (e.g.
    // `new URL("../x", import.meta.url)` silently becomes
    // "http://localhost:3000/x"). scripts/check-i18n.mjs (imported by the
    // existing i18n-parity test) relies on exactly that pattern to locate
    // the locales directory, so running it under `jsdom` breaks it. Plain
    // `.test.ts` files don't touch the DOM, so they run under the normal
    // Node environment (matching this repo's pre-vitest.config.ts baseline
    // behavior, bug-free); `.test.tsx` component tests run under `jsdom`,
    // which is what they actually need React Testing Library for.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.tsx"],
        },
      },
    ],
  },
});

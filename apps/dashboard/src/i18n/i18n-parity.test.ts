import { describe, it, expect } from "vitest";
// Shared with the `bun run i18n:check` CLI so the test and the tool agree on
// what "drift" means.
import { checkI18nParity, defaultLocalesDir } from "../../scripts/check-i18n.mjs";

/**
 * English (`locales/en`) is the source of truth; every other locale should
 * define the same key at every path (missing keys silently fall back to English
 * via i18n/index.ts deepMerge).
 *
 * This is a RATCHET, not a hard "0 drift" gate: the codebase currently carries a
 * backlog of English-first keys that aren't translated yet. The baseline below
 * captures that backlog PER NAMESPACE. The test fails only when drift GROWS —
 * a new English key with no translation, or a namespace that was clean starts
 * trailing. It never requires translating the existing backlog to stay green.
 *
 * When you translate keys, lower the matching number (or delete the entry once
 * it hits 0). `bun run i18n:check --full` lists exactly what's outstanding. The
 * goal is for every entry here to reach 0 and this map to be `{}`.
 */
const MISSING_BASELINE: Record<string, number> = {
  projectSettings: 1074,
  jobs: 876,
  migration: 851,
  settings: 564,
  emailsAdmin: 316,
  projects: 276,
  dashboard: 200,
  widgets: 138,
  misc: 123,
  overview: 120,
  servers: 114,
  importProject: 76,
  onboarding: 60,
  emails: 42,
  projectDetail: 42,
  brand: 40,
  deploy: 8,
  library: 7,
  billing: 6,
};

/** Stale locale keys that no longer exist in English. */
const EXTRA_BASELINE = 14;

describe("i18n locale parity vs the English source", () => {
  const report = checkI18nParity(defaultLocalesDir());

  it("introduces no NEW missing keys beyond the per-namespace baseline", () => {
    const regressions: string[] = [];
    const namespaces = new Set([
      ...Object.keys(MISSING_BASELINE),
      ...Object.keys(report.byNamespaceMissing),
    ]);
    for (const ns of namespaces) {
      const actual = report.byNamespaceMissing[ns] ?? 0;
      const allowed = MISSING_BASELINE[ns] ?? 0; // namespaces not listed must stay fully translated
      if (actual > allowed) regressions.push(`${ns}: ${actual} missing (baseline ${allowed})`);
    }
    expect(
      regressions,
      "New i18n drift vs English. Translate the missing keys (run `bun run i18n:check --full`), " +
        "or if you translated some, lower MISSING_BASELINE.\n" +
        regressions.join("\n"),
    ).toEqual([]);
  });

  it("introduces no NEW stale (extra) locale keys beyond the baseline", () => {
    expect(report.totalExtra).toBeLessThanOrEqual(EXTRA_BASELINE);
  });
});

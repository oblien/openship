import { describe, it, expect } from "vitest";
// Shared with the `bun run i18n:check` CLI so the test and the tool agree on
// what "drift" means.
import {
	checkI18nParity,
	defaultLocalesDir,
} from "../../scripts/check-i18n.mjs";

/**
 * English (`locales/en`) is the source of truth; every other locale should
 * define the same key at every path (missing keys silently fall back to English
 * via i18n/index.ts deepMerge).
 *
 * Full parity has been achieved across all 10 supported locales:
 * en, ru, de, es, fr, ja, pt, tr, zh, and ar.
 *
 * The baseline map is now empty (0 drift). Any missing key in any locale
 * will fail the test.
 */
const MISSING_BASELINE: Record<string, number> = {};

/** Stale locale keys that no longer exist in English. */
const EXTRA_BASELINE = 0;

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
			if (actual > allowed)
				regressions.push(`${ns}: ${actual} missing (baseline ${allowed})`);
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

	/**
	 * The check the two above CANNOT make.
	 *
	 * Both of them reason about key PRESENCE. A key that exists in all nine locales
	 * while still holding the English sentence is invisible to them — the locale is
	 * "complete", the suite is green, and the UI renders English. That is not
	 * hypothetical: `verifyEmail.code*` sat like that in 7 of 8 locales, and when the
	 * password-reset flow started rendering those same strings, the reset form shipped
	 * English labels and English error text to every non-English user while every test
	 * passed. Worse, `pendingSentTo` kept telling people to click a verification link
	 * for months after the email stopped containing one.
	 *
	 * So this ratchets on VALUES: a locale string byte-identical to English, restricted
	 * to prose (multi-word — see `looksTranslatable`) so that Email/DNS/GitHub/OK and
	 * `you@example.com` don't drown the signal. Same contract as MISSING_BASELINE:
	 * freeze today's backlog per namespace, fail only when it GROWS, and lower the
	 * number as things get translated.
	 *
	 * A namespace absent from this map must stay at zero.
	 */
	const UNTRANSLATED_BASELINE: Record<string, number> = {
		deploy: 133,
		settings: 97,
		projectSettings: 46,
		importProject: 43,
		billing: 24,
		onboarding: 24,
		projectDetail: 19,
		library: 16,
		misc: 14,
		projects: 17,
		deployments: 14,
		emailsAdmin: 12,
		overview: 12,
		chrome: 10,
		widgets: 9,
		dashboard: 6,
		emails: 6,
		servers: 5,
		migration: 3,
		jobs: 0,
		// `auth` is deliberately absent, i.e. pinned at 0: it was brought to zero when
		// password reset moved from a link to a code, and it is the flow where an
		// English-rendering string is most costly — somebody locked out of their account
		// reading instructions they cannot follow.
	};

	it("introduces no NEW untranslated values (present, but still the English string)", () => {
		const regressions: string[] = [];
		const namespaces = new Set([
			...Object.keys(UNTRANSLATED_BASELINE),
			...Object.keys(report.byNamespaceUntranslated),
		]);
		for (const ns of namespaces) {
			const actual = report.byNamespaceUntranslated[ns] ?? 0;
			const allowed = UNTRANSLATED_BASELINE[ns] ?? 0;
			if (actual > allowed) {
				regressions.push(`${ns}: ${actual} untranslated (baseline ${allowed})`);
			}
		}
		expect(
			regressions,
			"A locale now copies English verbatim where it did not before — the UI will " +
				"render English there while key parity still looks clean. Translate the " +
				"values (run `bun run i18n:check --full`), or if you translated some, lower " +
				"UNTRANSLATED_BASELINE.\n" +
				regressions.join("\n"),
		).toEqual([]);
	});
});

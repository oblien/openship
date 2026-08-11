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
  // +7: appSource.repository — the app Source tab's "Repository" link label.
  // Translated in tr (whose appSource block is otherwise complete); English-first
  // in the other 7 locales, which have no appSource block at all and fall back to
  // English via deepMerge, so the row renders correctly in every locale.
  //
  // +63: appInstall stepper — 9 keys for the JSON-mapped install progress view
  // (phase labels images/services/app-setup/ready + queued, the steps heading, and
  // the first-login title/username/password). Translated in tr; English-first in
  // the other 7 locales, which fall back via deepMerge so the stepper is correct
  // everywhere.
  //
  // +77: appInstall project-style redesign — 11 keys for the two-column install
  // view (status pill installing/live/cancelled/failed, Stop/stopping + stopFailed,
  // installCancelled + startOver, the Apps breadcrumb, and the aside App eyebrow).
  // Same convention: translated in tr, English-first in the other 7 (deepMerge
  // fallback), so the view is correct in every locale.
  // +21: appInstall.mail's send-only wiring — 5 net-new English keys (the
  // provider-agnostic "this relay holds no mailboxes" note + its no-inbox CTA, the
  // "mailboxes read from mail.<domain>" confirmation, and the steer to the
  // outbound-relay tab when this instance already hosts the mailboxes), minus the
  // two SES-branded keys they replace (sesNote, sesSelfHostCta — the note applies
  // to every send-only relay, not just SES). Translated in tr, which is the only
  // other locale with an appInstall block; the other 7 fall back to English via
  // deepMerge, so the wizard renders correctly everywhere.
  projectSettings: 1282,
  jobs: 876,
  // +15: discover.envFromImage/Hint/Import — the collapsed "vars come from the
  // image" row and its one-click import. Translated in ar/fr/tr; the other 5
  // locales have no migration.json at all and fall back via deepMerge.
  migration: 1252,
  // +64: the GitHub card's credential-health strings — 8 English-first keys for
  // "GitHub rejected the stored {method}" vs "couldn't reach GitHub to check it",
  // the manage-on-GitHub links, and the note that Disconnect does NOT revoke the
  // credential at GitHub. Same reasoning as permissions.sourceAccess below:
  // deliberately NOT machine-translated, because these decide whether an operator
  // believes a leaked token is dead, and whether they go revoke a credential that
  // was only unreachable. They fall back to English via deepMerge, so the UI is
  // correct everywhere — as is the rest of this card's block, which is also still
  // English-only in the other 8 locales.
  //
  // +184: settings.edgeOrphans — 23 English-first keys for the untracked-edge-routes
  // card. Same reasoning again, and it's the sharpest case yet: the primary action
  // there STOPS SERVING A HOSTNAME. An operator has to understand from the copy that
  // a "static" leftover is answering requests right now while an "app route" one is
  // already 502ing, that removing touches this hostname's edge config and nothing
  // else, and that built files stay on disk. A mistranslation is somebody taking a
  // live site offline, or leaving a forgotten one serving. English falls through via
  // deepMerge, so the card is correct in every locale, just not localised.
  //
  // -14: settings.infrastructure is now fully translated in all 9 locales (the
  // auto-scan toggle copy included) — the tab shrank to policy + a roll-up line,
  // so the list-era keys are gone and the remainder is short enough to translate.
  //
  // +144: Openship Mail's two mode pickers — settings.mailMode (instance-wide
  // default, 9 keys) and settings.productView (the per-user "which interface do I
  // get" choice, 8 keys), plus sidebar.tabs.systemSender, which renames the Email
  // tab to "System sender" in mail view so it isn't read as the mail server's own
  // config. Both are two-card pickers rather than toggles, so each carries a
  // label + description per mode. English-first in the other 8 locales via
  // deepMerge, so both render everywhere. The mail rail's own labels needed no new
  // baseline: the ten tab names reuse emailsAdmin.panel.tabs.*, and the nav/chrome
  // keys are translated in all 9 locales, keeping those namespaces at 0.
  // +112: the MCP tab's access editor — 14 net-new English keys × 8 locales. A
  // connected agent's scope is now editable in place (Edit access → the shared
  // AccessControlEditor), which needs its own verbs and, more importantly, the
  // widen-confirmation copy. Left English-first deliberately rather than
  // machine-translated: this block includes the "this removes every restriction"
  // confirmation, and a mistranslated security prompt is worse than an untranslated
  // one. The other 8 locales fall back via deepMerge, so the panel renders
  // correctly everywhere.
  settings: 1392,
  // +164: the Sending tab's rebuild — 21 net-new English keys (the direct-vs-relay
  // path picker and its switch-back action, the "which senders relay?" card with the
  // individual-sender editor, the manual SPF include for providers whose token is
  // account-specific, the :465-in-selected-scope error, and the aside summary), minus
  // six SES-branded keys the registry made wrong (scopeLabel, region, identities*,
  // dkim{Title,Hint}). Fifteen of the new ones are translated in tr, which is the only
  // other locale with a `sending` block at all; the remaining 7 locales have none and
  // fall back to English via deepMerge, so the tab renders correctly everywhere.
  //
  // +14: overview.legacyWebmail + overview.upgradeWebmail — the line under the mail
  // hostname offering to replace a PRE-CATALOG webmail (which reports installed, so
  // the CTA beside it stays "Open webmail" and nothing else would ever surface the
  // upgrade). Translated in tr; English-first in the other 7 via deepMerge. The
  // deploy screen's own four keys for the same flow are translated in all 8, keeping
  // `deploy` at 0.
  emailsAdmin: 806,
  // +360: permissions.sourceAccess — 45 keys for the source access modal and its
  // repository path tree,
  // still English in the other 8 locales (they fall back via deepMerge, so the UI
  // is correct everywhere, just not localised). Deliberately NOT machine-translated:
  // these strings drive a security decision — e.g. "a clone can't be limited to
  // paths, so local builds won't work" — and a subtly wrong translation would
  // mislead the operator choosing a grant. Lower this as they're translated.
  widgets: 498,
  // +40: mcpAuthorize gained 5 English-first keys — two digest lines that answer
  // "can it read my source?" either way, and three level tooltips.
  //
  // +88: restoreWizard gained 11 English-first keys for the apply-phase cancel
  // affordance (#434). Same reasoning as the security blocks above: these are the
  // strings that tell an operator whether aborting now loses data — "nothing has
  // been overwritten yet" vs "that volume now holds partial data, finish a restore
  // before starting the service". A mistranslation is somebody aborting a restore
  // believing the volume is intact, or leaving a half-written volume in service.
  // English falls through via deepMerge, so the wizard is correct in every locale.
  misc: 233,
  // -35: overview.issues (the home "needs attention" surface — edge down / not
  // installed / mail engine down + their actions) is now translated in all 9
  // locales, so the block no longer contributes.
  overview: 120,
  // +16: detail.reinstallDockerTitle/Message — the confirm shown before running
  // Docker's installer over a working Docker (#491). English-first in the other 8
  // locales (deepMerge fallback, so the modal renders correctly everywhere).
  // Deliberately not machine-translated: this copy is the whole consent — it has to
  // land that a "reinstall" is a major engine upgrade and that the daemon restart
  // takes every container on the server down with it. An operator who reads a
  // softened translation as "refresh the install" bounces their own stack.
  //
  // +32: banner.hostChannel* — 4 keys for the container→host SSH channel being
  // blocked (#490). Same reasoning: the copy's job is to stop an operator chasing
  // the wrong machine ("can't reach 127.0.0.1") and to frame the firewall rule it
  // shows — a rule that, misread as "open SSH", is someone exposing port 22 to the
  // internet. English-first in the other 8 locales via deepMerge.
  //
  // +32: banner.hostChannelMissing*/WouldUse/ProvisionFix — 4 more keys for the
  // channel that was never provisioned at all (#509), which needs `openship up`
  // rather than a firewall rule and must not name a machine nothing contacted.
  // English-first for the same reason, and kept in the SAME language as the four
  // above on purpose: they render in one banner, and half a translated block reads
  // worse than a consistent English one.
  //
  // +16: form.keyPathBrowse / form.keyPathHelp — the desktop "Browse…" file picker
  // for the SSH key, and the line saying the path belongs to the machine running
  // Openship (not the browser's). English-first in the other 8 locales via
  // deepMerge, same as the rest of this form's block.
  //
  // +72: form.keyMode{Paste,Path}/keyPaste/keyPastePlaceholder/keyPasteHelp/
  // keyStoredKeep/keyUploadFile/keyPasteInvalid/toastKeyRequired — 9 keys for the
  // new paste-or-upload SSH-key sub-mode (a browser can now hold the key material
  // instead of pointing at a file on the API host). English-first in the other 8
  // locales via deepMerge, same as the rest of this form's block.
  servers: 281,
  importProject: 81,
  onboarding: 60,
  // +16: setup.startFailed / startFailedFallback — the mail wizard had no way to
  // render a failure that happens BEFORE the progress stream exists (#492), so a
  // dead SSH executor showed an empty form. English-first in all 8 other locales
  // (deepMerge fallback), same as the rest of this namespace.
  emails: 58,
  projectDetail: 42,
  brand: 40,
  library: 119,
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

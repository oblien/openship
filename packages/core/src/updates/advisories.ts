/**
 * Advisory parsing + resolution. Pure functions over already-fetched data so
 * both the desktop main process and the dashboard share identical logic.
 */

import type { Advisory, AdvisoryManifest, AdvisoryMode, AdvisorySeverity, LatestRelease, UpdateState } from "./types";
import { ADVISORY_MODES } from "./types";
import { changelogUrl } from "./types";
import { compareSemver, satisfiesRange } from "./semver";

const SEVERITY_RANK: Record<AdvisorySeverity, number> = { critical: 0, recommended: 1, info: 2 };
const VALID_SEVERITY = new Set<AdvisorySeverity>(["critical", "recommended", "info"]);

/**
 * Parse + validate an UNTRUSTED manifest (fetched from GitHub raw). Malformed
 * entries are dropped rather than trusted — this is third-party-authored data
 * as far as any single client is concerned, so we treat it defensively.
 */
export function parseManifest(raw: unknown): AdvisoryManifest {
  const list = (raw as { advisories?: unknown } | null)?.advisories;
  if (!Array.isArray(list)) return { advisories: [] };

  const advisories: Advisory[] = [];
  for (const item of list) {
    const a = item as Partial<Advisory> | null;
    if (
      typeof a?.id !== "string" ||
      typeof a?.affects !== "string" ||
      typeof a?.title !== "string" ||
      typeof a?.message !== "string" ||
      !VALID_SEVERITY.has(a?.severity as AdvisorySeverity)
    ) {
      continue;
    }
    const advisory: Advisory = {
      id: a.id,
      severity: a.severity as AdvisorySeverity,
      // Normalized HERE, once, so every consumer reads a plain boolean. The
      // release script writes the key explicitly; a hand-written entry that
      // omits it falls back to "anything above info interrupts", which is what
      // pre-`announce` manifests meant. This is the only place severity is
      // allowed to imply anything about interrupting.
      announce: typeof a.announce === "boolean" ? a.announce : a.severity !== "info",
      affects: a.affects,
      title: a.title,
      message: a.message,
    };
    const action = a.action;
    if (
      action &&
      typeof action.label === "string" &&
      (action.kind === "update" || action.kind === "open-url" || action.kind === "update-entity")
    ) {
      advisory.action = {
        label: action.label,
        kind: action.kind,
        ...(typeof action.url === "string" ? { url: action.url } : {}),
        ...(typeof action.entityId === "string" ? { entityId: action.entityId } : {}),
      };
    }
    const target = a.target;
    if (
      target &&
      (target.type === "platform" ||
        target.type === "app" ||
        target.type === "project" ||
        target.type === "mail")
    ) {
      advisory.target = {
        type: target.type,
        ...(typeof target.id === "string" ? { id: target.id } : {}),
      };
    }
    if (Array.isArray(a.modes)) {
      const modes = a.modes.filter((m): m is AdvisoryMode =>
        ADVISORY_MODES.includes(m as AdvisoryMode),
      );
      // Only carry it when at least one mode survived: an all-garbage list must
      // fall back to "every mode" rather than "no mode", so a typo can never
      // silently mute an advisory everywhere.
      if (modes.length > 0) advisory.modes = modes;
    }
    advisories.push(advisory);
  }
  return { advisories };
}

/**
 * Advisories that apply to this client, most severe first.
 *
 * Two gates: the `affects` semver range must include `currentVersion`, and — when
 * the advisory names `modes` — this install's mode must be one of them. `mode`
 * is optional so a caller that genuinely doesn't know it still gets
 * version-matching behaviour; pass it wherever it's known (it always is in the
 * dashboard and the desktop app) so a desktop-only notice never lands on a VPS.
 */
export function matchAdvisories(
  currentVersion: string,
  manifest: AdvisoryManifest,
  mode?: AdvisoryMode,
): Advisory[] {
  return manifest.advisories
    .filter((a) => {
      // No `modes` = every mode (legacy default). With `modes`, an unknown
      // caller mode can't be matched, so the advisory is skipped rather than
      // shown to the wrong audience.
      if (a.modes && a.modes.length > 0 && (!mode || !a.modes.includes(mode))) return false;
      try {
        return satisfiesRange(currentVersion, a.affects);
      } catch {
        return false;
      }
    })
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
}

/**
 * The advisory that authorizes INTERRUPTING this install (launch modal,
 * notification), or null to stay quiet — the single answer to "should we
 * prompt?".
 *
 * Everything comes from the advisory: which versions it applies to (`affects`),
 * which installs (`modes`), and whether it may interrupt at all (`announce`).
 * A newer release existing is not part of this decision, so nothing here
 * re-checks versions against the release feed. Most severe first, so the
 * loudest matching announcement is the one returned.
 */
export function findAnnouncement(
  currentVersion: string,
  manifest: AdvisoryManifest | null | undefined,
  mode?: AdvisoryMode,
): Advisory | null {
  if (!manifest) return null;
  return matchAdvisories(currentVersion, manifest, mode).find((a) => a.announce) ?? null;
}

export interface ResolveUpdateInput {
  currentVersion: string;
  latestRelease: LatestRelease | null;
  manifest: AdvisoryManifest | null;
  /** Advisory ids the user already dismissed (ignored for critical). */
  dismissed?: readonly string[];
  /** User disabled follow-up notifications. Critical advisories still surface once. */
  muted?: boolean;
  /** This install's kind, so mode-targeted advisories are filtered correctly. */
  mode?: AdvisoryMode;
}

/**
 * Fold fetched data + user prefs into what the UI should show. The muting rule
 * encodes the product decision: a `critical` advisory is ALWAYS shown once;
 * `recommended`/`info` respect the mute toggle and per-id dismissal.
 */
export function resolveUpdateState(input: ResolveUpdateInput): UpdateState {
  const { currentVersion, latestRelease, manifest, dismissed = [], muted = false, mode } = input;

  const latestVersion = latestRelease?.version ?? null;
  const updateAvailable = !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;

  const advisories = (manifest ? matchAdvisories(currentVersion, manifest, mode) : []).filter((a) => {
    if (a.severity === "critical") return true;
    if (muted) return false;
    return !dismissed.includes(a.id);
  });

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    advisories,
    changelogUrl: changelogUrl(),
    latestChangelogUrl: changelogUrl(latestRelease?.tag),
  };
}

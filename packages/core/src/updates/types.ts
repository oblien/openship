/**
 * Update & advisory types, shared by the desktop app and the dashboard.
 *
 * Advisories are pulled from the repo, but PINNED TO THE LATEST RELEASE TAG
 * (see `advisoryManifestUrl`) — never from `main` — so a push to main with no
 * new version can't change what any client sees. Clients only ever PULL from
 * the public GitHub repo; nothing pushes to them.
 */

export type AdvisorySeverity = "critical" | "recommended" | "info";

export interface AdvisoryAction {
  label: string;
  /**
   * How the banner's button behaves:
   *   - "update"        → drive the desktop native updater (desktop only).
   *   - "open-url"      → open `url` externally.
   *   - "update-entity" → web-safe update: the dashboard POSTs the apply
   *                       endpoint for `entityId` (an app/project/self-app),
   *                       then shows deploy progress. Used by the update
   *                       advisories the scanner synthesizes.
   */
  kind: "update" | "open-url" | "update-entity";
  url?: string;
  /** For "update-entity": the project/app id to apply the update to. */
  entityId?: string;
}

/** What an advisory is about — lets a notice/update target one app/project. */
export interface AdvisoryTarget {
  type: "platform" | "app" | "project" | "mail";
  /** Project/app id when scoped; omitted for platform-wide. */
  id?: string;
}

/**
 * Which kind of install an advisory applies to.
 *
 *   desktop     the Electron app (its own installer + in-app updater)
 *   selfhosted  a server/VPS install (compose or bare), updated by the operator
 *   cloud       the managed SaaS — nothing for a user to update
 *
 * A release usually only matters to some of these: a desktop installer fix is
 * noise on a VPS, and an edge/OpenResty fix is noise in the desktop app. An
 * advisory with no `modes` applies to ALL of them (the legacy default, so
 * existing manifests keep working).
 */
export type AdvisoryMode = "desktop" | "selfhosted" | "cloud";

export const ADVISORY_MODES: readonly AdvisoryMode[] = ["desktop", "selfhosted", "cloud"];

export interface Advisory {
  /** Stable id — used for per-advisory dismissal. */
  id: string;
  severity: AdvisorySeverity;
  /**
   * THE interrupt gate, declared by the advisory itself: may this one pull the
   * user out of what they're doing (desktop launch modal, notification), or is
   * it in-app surfaces only? `severity` is how LOUD the banner is; `announce` is
   * whether we're allowed to interrupt — two different decisions, so this is an
   * explicit key rather than something each client re-derives from severity.
   * `parseManifest` always fills it in, so consumers just read it.
   */
  announce: boolean;
  /** Version range this targets, e.g. "<=0.1.8" or ">=0.1.0 <0.1.9". */
  affects: string;
  title: string;
  message: string;
  action?: AdvisoryAction;
  /** Optional scope. Absent = platform-wide (the legacy default). */
  target?: AdvisoryTarget;
  /**
   * Install kinds this applies to. Absent/empty = every mode (legacy default).
   * Filtered client-side by `matchAdvisories`, so a desktop-only advisory never
   * reaches a VPS dashboard and vice versa.
   */
  modes?: AdvisoryMode[];
}

export interface AdvisoryManifest {
  advisories: Advisory[];
}

export interface LatestRelease {
  /** Version without a leading "v", e.g. "0.1.9". */
  version: string;
  /** Raw tag, e.g. "v0.1.9". */
  tag: string;
  /** Release notes (markdown/plain) from the GitHub release body. */
  notes: string;
}

export interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Advisories that apply to the current version, most severe first. */
  advisories: Advisory[];
  /** Link to all releases. */
  changelogUrl: string;
  /** Link to the latest release's notes (tag-specific), or all releases. */
  latestChangelogUrl: string;
}

export const GITHUB_REPO = "oblien/openship";

/** GitHub API: the latest published (non-prerelease) release. */
export const RELEASES_LATEST_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * Raw advisory manifest URL, PINNED to a release tag. Because it's pinned to a
 * tag (not a branch), it only changes when a version is released — commits to
 * `main` are invisible to clients. Returns null for an empty tag.
 */
export function advisoryManifestUrl(tag: string): string {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(tag)}/release-advisories.json`;
}

/** Human-facing changelog link — a specific tag's notes, or all releases. */
export function changelogUrl(tag?: string): string {
  return tag
    ? `https://github.com/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tag)}`
    : `https://github.com/${GITHUB_REPO}/releases`;
}

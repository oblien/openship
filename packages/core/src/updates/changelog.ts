import { BRAND_LINKS } from "../constants";
import { GITHUB_REPO } from "./types";

/** Raw repository changelog pinned to a branch or release tag. */
export function changelogMarkdownUrl(ref: string): string {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(ref)}/CHANGELOG.md`;
}

export { normalizeChangelogVersion, parseChangelog, extractChangelogSection } from "./changelog-parser";

/** Public website changelog, optionally deep-linked to one released version. */
export function changelogUrl(tag?: string): string {
  const version = tag?.replace(/^v/, "").match(/^(\d+\.\d+\.\d+)$/)?.[1];
  return version
    ? `${BRAND_LINKS.site}/changelog/v${version.replaceAll(".", "-")}`
    : `${BRAND_LINKS.site}/changelog`;
}

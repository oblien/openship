import { advisoryManifestUrl, type AdvisoryManifest, type ReleaseFeedSnapshot } from "./types";
import { changelogMarkdownUrl, extractChangelogSection } from "./changelog";
import { parseManifest } from "./advisories";
import { reportCaughtError } from "../diagnostics/index";

/** Tagged notes and advisories fail independently. The caller owns caching and credentials. */
export async function releaseDocuments(
  tag: string,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseFeedSnapshot> {
  if (!/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag)) throw new Error("Invalid release tag");
  const latest = { tag, version: tag.replace(/^v/, ""), notes: "" };
  let manifest: AdvisoryManifest | null = null;
  await Promise.all([
    (async () => {
      try {
        const response = await fetcher(changelogMarkdownUrl(tag));
        if (response.ok)
          latest.notes = extractChangelogSection(await response.text(), latest.version);
      } catch (error) {
        reportCaughtError(error, "core/updates/release-documents.changelog");
        /* The advisory document remains independently usable. */
      }
    })(),
    (async () => {
      try {
        const response = await fetcher(advisoryManifestUrl(tag));
        if (response.ok) manifest = parseManifest(await response.json());
      } catch (error) {
        reportCaughtError(error, "core/updates/release-documents.advisories");
        /* A missing notice never hides the release itself. */
      }
    })(),
  ]);
  return { latest, manifest };
}

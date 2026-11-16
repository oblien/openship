import { parseChangelog } from "@repo/core";

const REPO = "oblien/openship";
export const CHANGELOG_REVALIDATE = 600;
type FetchSource = (
  url: string,
  init: RequestInit & { next?: { revalidate: number | false } },
) => Promise<Response>;

/** A release catalog is atomic: an upstream failure must never become a missing release. */
export async function loadPublishedChangelog(fetchSource: FetchSource = fetch) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "openship-web",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const md = await fetchSource(`https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`, {
    next: { revalidate: CHANGELOG_REVALIDATE },
  });
  if (!md.ok) throw new Error(`Changelog source unavailable (${md.status})`);
  const entries = parseChangelog(await md.text());
  if (!entries.length) throw new Error("Changelog source contains no releases");
  const tags = new Map<string, string>();
  for (let page = 1; ; page++) {
    const response = await fetchSource(
      `https://api.github.com/repos/${REPO}/tags?per_page=100&page=${page}`,
      {
        headers,
        next: { revalidate: CHANGELOG_REVALIDATE },
      },
    );
    if (!response.ok) throw new Error(`Release tags unavailable (${response.status})`);
    const batch: { name: string; commit: { sha: string } }[] = await response.json();
    if (!Array.isArray(batch)) throw new Error("Invalid release tags response");
    for (const tag of batch) {
      if (!/^v\d+\.\d+\.\d+$/.test(tag?.name)) continue;
      if (!/^[a-f0-9]{40}$/.test(tag.commit?.sha))
        throw new Error(`Invalid release commit for ${tag.name}`);
      tags.set(tag.name.slice(1), tag.commit.sha);
    }
    if (batch.length < 100) break;
  }
  if (!tags.size) throw new Error("Release tags response contains no published versions");
  const published = entries.filter((entry) => tags.has(entry.version));
  if (!published.length) throw new Error("Changelog source has no matching published releases");

  return Promise.all(
    published.map(async (entry) => {
      // Explicit force-cache preserves immutable lookups inside the catalog's unstable_cache.
      // A next.revalidate hint alone is bypassed in that scope.
      const response = await fetchSource(
        `https://api.github.com/repos/${REPO}/commits/${tags.get(entry.version)}`,
        {
          headers,
          cache: "force-cache",
        },
      );
      if (!response.ok)
        throw new Error(`Release date unavailable for ${entry.version} (${response.status})`);
      const value: { commit?: { committer?: { date?: string }; author?: { date?: string } } } =
        await response.json();
      const date = value.commit?.committer?.date ?? value.commit?.author?.date;
      if (!date || !Number.isFinite(Date.parse(date)))
        throw new Error(`Invalid release date for ${entry.version}`);
      return { ...entry, date };
    }),
  );
}

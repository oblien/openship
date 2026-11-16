import { describe, expect, test } from "bun:test";
import { loadPublishedChangelog } from "../src/lib/changelog-source";

const sha = "a".repeat(40);
const markdown = "# Changelog\n\n## 0.9.13\n\nNot released.\n\n## 0.9.12\n\nPublished release.\n";
const date = "2026-11-01T12:00:00Z";
type FetchSource = NonNullable<Parameters<typeof loadPublishedChangelog>[0]>;
const fixture: FetchSource = async (url) => {
  if (url.includes("raw.githubusercontent.com")) return new Response(markdown);
  if (url.includes("/tags?")) return Response.json([{ name: "v0.9.12", commit: { sha } }]);
  return Response.json({ commit: { committer: { date } } });
};

describe("published release catalog", () => {
  test("only tagged releases appear, and immutable commits supply cached dates", async () => {
    const requests: { url: string; init: Parameters<FetchSource>[1] }[] = [];
    const entries = await loadPublishedChangelog(async (url, init) => {
      requests.push({ url, init });
      return fixture(url, init);
    });
    expect(entries.map(({ version, date }) => ({ version, date }))).toEqual([
      { version: "0.9.12", date },
    ]);
    const commit = requests.find(({ url }) => url.includes("/commits/"))!;
    expect(commit.url.endsWith(sha)).toBe(true);
    expect(commit.init.cache).toBe("force-cache");
    expect(commit.init.next).toBeUndefined();
  });

  for (const endpoint of ["raw.githubusercontent.com", "/tags?", "/commits/"]) {
    test(`a rate limit at ${endpoint} fails revalidation instead of publishing missing releases`, async () => {
      await expect(
        loadPublishedChangelog((url, init) =>
          url.includes(endpoint)
            ? Promise.resolve(new Response("Rate limited", { status: 429 }))
            : fixture(url, init),
        ),
      ).rejects.toThrow("unavailable");
    });
  }

  test("malformed dates and empty release sources fail instead of silently dropping pages", async () => {
    await expect(
      loadPublishedChangelog((url, init) =>
        url.includes("/commits/")
          ? Promise.resolve(Response.json({ commit: {} }))
          : fixture(url, init),
      ),
    ).rejects.toThrow("Invalid release date");
    await expect(
      loadPublishedChangelog((url, init) =>
        url.includes("raw.githubusercontent.com")
          ? Promise.resolve(new Response("# Temporarily unavailable"))
          : fixture(url, init),
      ),
    ).rejects.toThrow("no releases");
  });

  test("older releases remain discoverable beyond the first tags page", async () => {
    const entries = await loadPublishedChangelog((url, init) => {
      if (url.includes("/tags?") && url.endsWith("page=1")) {
        return Promise.resolve(
          Response.json(
            Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}`, commit: { sha } })),
          ),
        );
      }
      return fixture(url, init);
    });
    expect(entries[0]?.version).toBe("0.9.12");
  });

  test("invalid release identities cannot silently remove published pages", async () => {
    for (const tags of [
      [{ name: "v0.9.12", commit: { sha: "invalid" } }],
      [{ name: "v0.1.0", commit: { sha } }],
    ]) {
      await expect(
        loadPublishedChangelog((url, init) =>
          url.includes("/tags?") ? Promise.resolve(Response.json(tags)) : fixture(url, init),
        ),
      ).rejects.toThrow();
    }
  });
});

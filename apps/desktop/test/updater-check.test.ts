import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  net: { fetch: fetcher },
  shell: {},
}));

const release = {
  tag_name: "v99.0.0",
  assets: [
    "Openship-arm64.dmg",
    "Openship-x64.dmg",
    "Openship-win32-x64.zip",
    "Openship.AppImage",
    "Openship-arm64.AppImage",
  ].map((name) => ({
    name,
    browser_download_url: `https://github.com/oblien/openship/releases/download/v99.0.0/${name}`,
    size: 20,
  })),
};
const manifest = {
  advisories: [
    {
      id: "urgent",
      severity: "critical",
      title: "Upgrade",
      message: "Fix available",
      affects: "<99.0.0",
    },
  ],
};
function feed(url: string | URL | Request) {
  if (String(url).endsWith("/latest")) return new Response(JSON.stringify(release));
  if (String(url).endsWith("CHANGELOG.md")) return new Response("## 99.0.0\n\nReal product notes.");
  return new Response(JSON.stringify(manifest));
}

beforeEach(() => {
  vi.resetModules();
  fetcher.mockReset().mockImplementation(async (url) => feed(url));
});

describe("desktop release snapshot ownership (#661)", () => {
  it("shares startup, renderer and simultaneous forced checks", async () => {
    const { checkForUpdate } = await import("../src/main/updater");
    const results = await Promise.all([
      checkForUpdate(),
      checkForUpdate(),
      checkForUpdate({ force: true }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      available: true,
      latest: { tag: "v99.0.0", notes: "Real product notes." },
      manifest: { advisories: [expect.objectContaining({ id: "urgent" })] },
    });
    await checkForUpdate();
    expect(fetcher).toHaveBeenCalledTimes(3);
    await checkForUpdate({ force: true });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("retains release notes and advisories when there is no installable asset", async () => {
    fetcher.mockImplementation(async (url) =>
      String(url).endsWith("/latest")
        ? new Response(JSON.stringify({ tag_name: release.tag_name, assets: [] }))
        : feed(url),
    );
    const { checkForUpdate } = await import("../src/main/updater");
    expect(await checkForUpdate()).toMatchObject({
      available: false,
      latest: { version: "99.0.0" },
      manifest: { advisories: [expect.objectContaining({ id: "urgent" })] },
    });
  });

  it("does not cache an offline failure as the session's release", async () => {
    fetcher.mockRejectedValueOnce(new Error("offline"));
    const { checkForUpdate } = await import("../src/main/updater");
    expect(await checkForUpdate()).toMatchObject({ available: false, latest: null });
    expect((await checkForUpdate()).available).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps critical advisories if the changelog request fails", async () => {
    fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("CHANGELOG.md")) throw new Error("unavailable");
      return feed(url);
    });
    const { checkForUpdate } = await import("../src/main/updater");
    expect(await checkForUpdate()).toMatchObject({
      latest: { notes: "" },
      manifest: { advisories: [expect.objectContaining({ id: "urgent" })] },
    });
  });
});

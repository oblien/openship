import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppTemplate } from "@repo/core";

vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/lib/release-dist", () => ({ readApiVersion: () => "0.8.0" }));

const fetchCatalog = vi.fn();
const bundled = getAppTemplate("convex")!;
// Reproduce a local catalog edit that has not reached GitHub main yet.
const published = { ...bundled };
delete published.installLayout;

beforeEach(() => {
  vi.resetModules();
  fetchCatalog
    .mockReset()
    .mockImplementation(async () => Response.json({ version: 1, apps: [published] }));
  vi.stubGlobal("fetch", fetchCatalog);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("runtime catalog source", () => {
  it("keeps the checked-out template throughout development requests", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { getRuntimeTemplate } =
      await import("@repo/platform/engine/modules/apps/catalog-source");
    const { drainBackgroundWork } = await import("@repo/platform/engine/lib/background-work");

    expect(bundled.installLayout).toBeDefined();
    expect(getRuntimeTemplate("convex")).toEqual(bundled);
    await drainBackgroundWork();

    expect(getRuntimeTemplate("convex")).toEqual(bundled);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("still applies and caches the published catalog in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getRuntimeTemplate } =
      await import("@repo/platform/engine/modules/apps/catalog-source");
    const { drainBackgroundWork } = await import("@repo/platform/engine/lib/background-work");

    getRuntimeTemplate("convex");
    await drainBackgroundWork();

    expect(getRuntimeTemplate("convex")).toEqual(published);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
  });
});

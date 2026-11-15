import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ find: vi.fn(), cache: vi.fn(), fetch: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: { project: { findById: h.find, updateFaviconCache: h.cache } },
}));
vi.mock("../src/engine/config/env", () => ({ env: { CLOUD_MODE: true } }));
vi.mock("../src/engine/lib/safe-fetch", () => ({ safeFetch: h.fetch }));
import {
  detectAndStoreFavicon,
  refreshProjectFaviconIfStale,
} from "../src/engine/lib/favicon-detector";

beforeEach(() => {
  vi.resetAllMocks();
  h.cache.mockResolvedValue(undefined);
  h.fetch.mockResolvedValue({ ok: true, headers: { "content-type": "image/png" } });
});

it("does not schedule read-time discovery when an override exists", () => {
  refreshProjectFaviconIfStale({
    id: "p",
    activeDeploymentId: "d",
    iconUrl: "https://cdn.example.test/custom.png",
  });
  expect(h.find).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
});

it("does not fetch either the deployed site or the custom URL after a deployment", async () => {
  h.find.mockResolvedValue({ iconUrl: "https://cdn.example.test/custom.png" });
  await detectAndStoreFavicon("p", "https://app.example.test");
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.cache).not.toHaveBeenCalled();
});

it("uses the existing protected discovery flow again after clearing the override", async () => {
  h.find.mockResolvedValue({ iconUrl: null });
  await detectAndStoreFavicon("p", "https://app.example.test");
  expect(h.fetch).toHaveBeenCalledWith(
    "https://app.example.test/favicon.ico",
    expect.objectContaining({ allowPrivate: false, maxRedirects: 3 }),
  );
  expect(h.cache).toHaveBeenCalledWith(
    "p",
    expect.objectContaining({ favicon: "https://app.example.test/favicon.ico" }),
  );
});

it("keeps discovery best-effort when the override lookup fails", async () => {
  h.find.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(detectAndStoreFavicon("p", "https://app.example.test")).resolves.toBeUndefined();
  expect(h.fetch).not.toHaveBeenCalled();
});

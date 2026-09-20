import { describe, expect, it } from "vitest";
import type { ProjectResources } from "@repo/core";
import { normalizeProjectResourcesResponse } from "./project-resources";

const resources = {
  production: { cpuCores: 1, memoryMb: 1024, diskMb: 16384 },
  build: { cpuCores: 2, memoryMb: 2048, diskMb: 32768 },
  sleepMode: "auto_sleep",
  port: 3000,
  tier: "medium",
  capacity: { cpuCores: 8, memoryMb: 16384, source: "docker" },
  requiresLimit: false,
} satisfies ProjectResources;

describe("normalizeProjectResourcesResponse", () => {
  it("normalizes the legacy data-only envelope", () => {
    expect(normalizeProjectResourcesResponse({ data: resources })).toEqual({
      success: true,
      data: resources,
    });
  });

  it("accepts the current success envelope", () => {
    expect(normalizeProjectResourcesResponse({ success: true, data: resources })).toEqual({
      success: true,
      data: resources,
    });
  });

  it("does not mistake an explicit failure with data for success", () => {
    expect(() =>
      normalizeProjectResourcesResponse({ success: false, data: resources, error: "Not allowed" }),
    ).toThrow("Not allowed");
  });

  it("rejects missing or malformed resource data", () => {
    expect(() => normalizeProjectResourcesResponse({ success: true })).toThrow("invalid response");
    expect(() => normalizeProjectResourcesResponse({ success: "true", data: resources })).toThrow(
      "invalid response",
    );
    expect(() => normalizeProjectResourcesResponse({ data: null })).toThrow("invalid response");
  });
});

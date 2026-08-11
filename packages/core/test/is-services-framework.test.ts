import { describe, expect, it } from "vitest";

import { isServicesFramework } from "../src/stacks";

describe("isServicesFramework", () => {
  it("is TRUE only for a compose/services-stack project (service-first)", () => {
    expect(isServicesFramework("docker-compose")).toBe(true);
  });

  it("is FALSE for a single/static app — so adding a sidecar service never flips it", () => {
    expect(isServicesFramework("nextjs")).toBe(false);
    expect(isServicesFramework("static")).toBe(false);
    expect(isServicesFramework("node")).toBe(false);
    expect(isServicesFramework("vite")).toBe(false);
    // A single Docker(file) app is still one app, not service-first.
    expect(isServicesFramework("docker")).toBe(false);
  });

  it("is FALSE (never throws) for empty / unknown frameworks", () => {
    expect(isServicesFramework(undefined)).toBe(false);
    expect(isServicesFramework(null)).toBe(false);
    expect(isServicesFramework("")).toBe(false);
    expect(isServicesFramework("totally-made-up")).toBe(false);
  });
});

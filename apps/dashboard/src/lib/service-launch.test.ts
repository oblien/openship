import { describe, expect, it } from "vitest";
import { serviceCanStartWithoutBuild, serviceUsesDeployPipeline } from "./api/services";

describe("service launch actions", () => {
  it("starts an image service with named storage directly", () => {
    const service = { image: "redis:8", volumes: ["cache:/data"] };
    expect(serviceCanStartWithoutBuild(service)).toBe(true);
  });

  it.each(["./redis.conf:/etc/redis.conf:ro", "../config:/config:ro,z", ".:/app"])(
    "offers deployment for %s so repository files are prepared",
    mount => {
      const service = { image: "redis:8", volumes: [mount] };
      expect(serviceCanStartWithoutBuild(service)).toBe(false);
      expect(serviceUsesDeployPipeline(service)).toBe(true);
    },
  );

  it("does not offer image-only Start for an unbuilt sub-app", () => {
    const service = { kind: "monorepo", image: null, build: null };
    expect(serviceCanStartWithoutBuild(service)).toBe(false);
    expect(serviceUsesDeployPipeline(service)).toBe(true);
  });

  it("can start an existing image of a source service without rebuilding it", () => {
    expect(serviceCanStartWithoutBuild({ build: ".", image: "openship/app:built" })).toBe(true);
  });
});

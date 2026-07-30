import { describe, expect, it } from "vitest";
import { validateStackSource } from "./swarm-source.model";
import { parseSafeSwarmYaml } from "./swarm-yaml";

describe("safe Swarm YAML parsing", () => {
  it("accepts ordinary Compose YAML and preserves standard anchors", () => {
    expect(parseSafeSwarmYaml("x-image: &image nginx:alpine\nservices:\n  web:\n    image: *image\n"))
      .toMatchObject({ services: { web: { image: "nginx:alpine" } } });
  });

  it("rejects custom tags and duplicate keys without including source in the error", () => {
    expect(() => validateStackSource({
      kind: "inline",
      yaml: "services: !evil { web: nginx:alpine }",
      expectedVersion: 1,
    })).toThrow(expect.objectContaining({ code: "SWARM_SOURCE_YAML_TAG_UNSUPPORTED" }));
    expect(() => parseSafeSwarmYaml("services: {}\nservices: {}", "Inline stack YAML"))
      .toThrow(expect.objectContaining({ code: "SWARM_SOURCE_INVALID" }));
  });

  it("rejects cyclic aliases and excessive nesting before source persistence", () => {
    expect(() => validateStackSource({
      kind: "inline",
      yaml: "services: &cycle { web: *cycle }",
      expectedVersion: 1,
    })).toThrow(expect.objectContaining({ code: "SWARM_SOURCE_TOO_COMPLEX" }));

    const deeplyNested = "services:\n  web:\n" + Array.from(
      { length: 65 },
      (_, index) => " ".repeat((index + 2) * 2) + "child:\n",
    ).join("") + " ".repeat(134) + "image: nginx:alpine\n";
    expect(() => validateStackSource({
      kind: "inline",
      yaml: deeplyNested,
      expectedVersion: 1,
    })).toThrow(expect.objectContaining({ code: "SWARM_SOURCE_TOO_COMPLEX" }));
  });
});

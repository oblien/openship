import { describe, expect, it } from "vitest";
import { containerInfoFromDockerSummary, dockerPublishedPortInfo } from "./docker-container-info";
import type { DockerContainerSummary } from "./types";

describe("Docker container information normalization", () => {
  it("prefers Openship's loopback publish and preserves one mapping per container port", () => {
    expect(
      dockerPublishedPortInfo([
        { privatePort: 3000, publicPort: 80, type: "tcp", ip: "0.0.0.0" },
        { privatePort: 4000, publicPort: 40_000, type: "tcp", ip: "127.0.0.1" },
        { privatePort: 3000, publicPort: 20_008, type: "tcp", ip: "127.0.0.1" },
        { privatePort: 3000, publicPort: 53, type: "udp", ip: "127.0.0.1" },
      ]),
    ).toEqual({
      hostPort: 20_008,
      hostPortByContainerPort: { 3000: 20_008, 4000: 40_000 },
    });
  });

  it("ignores invalid, unpublished, and non-TCP port rows", () => {
    expect(
      dockerPublishedPortInfo([
        { privatePort: 0, publicPort: 20_000, type: "tcp" },
        { privatePort: 65_536, publicPort: 20_001, type: "tcp" },
        { privatePort: 3000, publicPort: 0, type: "tcp" },
        { privatePort: 3001, publicPort: -1, type: "tcp" },
        { privatePort: 3002, publicPort: 65_536, type: "tcp" },
        { privatePort: 3003, publicPort: Number.NaN, type: "tcp" },
        { privatePort: 3004, publicPort: 20_004, type: "udp" },
      ]),
    ).toEqual({});
  });

  it.each([
    ["running", "running"],
    ["restarting", "running"],
    ["dead", "failed"],
    ["exited", "stopped"],
  ] as const)("maps Docker state %s to runtime state %s", (state, status) => {
    const summary: DockerContainerSummary = {
      id: "container-id",
      names: ["openship-app-api"],
      image: "api:latest",
      imageId: "sha256:api",
      state,
      status: state,
      labels: {},
      ports: [],
      mounts: [],
      ip: "172.18.0.8",
    };

    expect(containerInfoFromDockerSummary(summary)).toEqual({
      containerId: "container-id",
      status,
      ip: "172.18.0.8",
    });
  });
});

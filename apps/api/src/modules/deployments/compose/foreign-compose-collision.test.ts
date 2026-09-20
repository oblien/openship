import { describe, expect, it } from "vitest";
import type { DockerContainerSummary } from "@repo/adapters";
import { findForeignComposeCollisions } from "@repo/platform/engine/modules/deployments/compose/foreign-compose-collision";

const container = (over: Partial<DockerContainerSummary> & { id: string }) =>
  ({ names: [], labels: {}, ports: [], mounts: [], state: "running", ...over }) as DockerContainerSummary;

describe("foreign Compose collision gate", () => {
  it("finds the old CLI stack before a normal same-slug deploy creates duplicates", () => {
    expect(
      findForeignComposeCollisions({
        slug: "openship",
        serviceNames: ["api", "dashboard", "web"],
        containers: [
          container({
            id: "old_api",
            names: ["openship-api-1"],
            composeProject: "openship",
            composeService: "api",
          }),
          container({
            id: "other",
            names: ["another-db-1"],
            composeProject: "another",
            composeService: "db",
          }),
        ],
      }),
    ).toEqual([{ serviceName: "api", containerName: "openship-api-1" }]);
  });

  it("does not call a tracked/adopted container foreign", () => {
    expect(
      findForeignComposeCollisions({
        slug: "openship",
        serviceNames: ["api"],
        trackedContainerIds: ["old_api"],
        containers: [
          container({
            id: "old_api",
            names: ["openship-api-1"],
            composeProject: "openship",
            composeService: "api",
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("ignores same-named services from a different Compose project", () => {
    expect(
      findForeignComposeCollisions({
        slug: "shop",
        serviceNames: ["api"],
        containers: [
          container({
            id: "other_api",
            names: ["another-api-1"],
            composeProject: "another",
            composeService: "api",
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("ignores a same-project container for a service this deployment does not own", () => {
    expect(
      findForeignComposeCollisions({
        slug: "shop",
        serviceNames: ["web"],
        containers: [
          container({
            id: "worker",
            names: ["shop-worker-1"],
            composeProject: "shop",
            composeService: "worker",
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("ignores an exited legacy container after the old stack was stopped", () => {
    expect(
      findForeignComposeCollisions({
        slug: "openship",
        serviceNames: ["api", "dashboard"],
        containers: [
          container({
            id: "old_api",
            state: "exited",
            names: ["openship-api-1"],
            composeProject: "openship",
            composeService: "api",
          }),
          container({
            id: "new_api",
            state: "created",
            names: ["openship-api-2"],
            composeProject: "openship",
            composeService: "api",
          }),
        ],
      }),
    ).toEqual([{ serviceName: "api", containerName: "openship-api-2" }]);
  });
});

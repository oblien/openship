import { expect, it } from "vitest";
import { validateSwapDisabled } from "@repo/core";
import { toDiscoveredService } from "@repo/platform/engine/modules/migration/docker-reconcile";
import { buildAdoptedServiceRows } from "@repo/platform/engine/modules/migration/migrate.service";

const live = {
  id: "container",
  name: "vault",
  image: "example/vault:1",
  imageId: "sha256:vault",
  state: "running",
  env: [],
  labels: {},
  networks: [],
  mounts: [],
  ports: [],
  resources: { memoryMb: 1024, swapDisabled: true },
};

it("keeps live swap protection and its memory cap alongside a CPU-only Compose declaration", () => {
  const discovered = toDiscoveredService(live, {
    name: "vault",
    image: live.image,
    ports: [],
    dependsOn: [],
    environment: {},
    volumes: [],
    advanced: { resources: { cpuCores: 0.5 } },
  });
  const { rows } = buildAdoptedServiceRows([discovered]);
  expect(rows[0]?.advanced?.resources).toEqual({
    cpuCores: 0.5,
    memoryMb: 1024,
    swapDisabled: true,
  });
  expect(() => validateSwapDisabled(rows[0]?.advanced?.resources)).not.toThrow();
});

it("honors an explicit swap opt-out in an adoption declaration", () => {
  const discovered = toDiscoveredService(live, {
    name: "vault",
    image: live.image,
    ports: [],
    dependsOn: [],
    environment: {},
    volumes: [],
    advanced: { resources: { memoryMb: 0, swapDisabled: false } },
  });
  expect(discovered.resources).toEqual({ memoryMb: 0, swapDisabled: false });
});

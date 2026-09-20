import { describe, expect, it, vi } from "vitest";

import { CloudComposeSupport } from "./compose";
import type { MultiServiceDeployConfig } from "../types";

const config: MultiServiceDeployConfig = {
  deploymentId: "dep-1",
  projectId: "project-1",
  slug: "demo",
  serviceName: "api",
  image: "ghcr.io/acme/api:staging",
  ports: [],
  environment: {},
  volumes: [],
  namespaceVolumes: true,
  previousWorkspaceId: "workspace-live",
  forcePull: true,
};

describe("cloud compose forced image refresh", () => {
  it("fails before touching a persistent image workspace", async () => {
    const workspace = vi.fn();
    const support = new CloudComposeSupport({
      builtArtifacts: new Map(),
      workspace,
    } as never);
    const group = await support.ensureServiceGroup({
      deploymentId: config.deploymentId,
      projectId: config.projectId,
      slug: config.slug,
    });

    await expect(support.deployServiceWorkload(group, config)).rejects.toThrow(
      /cannot refresh image.*persistent workspace/i,
    );
    expect(workspace).not.toHaveBeenCalled();
  });

  it("allows a newly built workspace to replace the old one", async () => {
    const builtWorkspace = {
      lifecycle: { makePermanent: vi.fn(async () => undefined) },
      resources: { update: vi.fn(async () => undefined) },
      workloads: {
        delete: vi.fn(async () => undefined),
        create: vi.fn(async () => undefined),
      },
      network: {
        get: vi.fn(async () => ({ ip: "10.0.0.8", ingress_ports: [] })),
        update: vi.fn(async () => undefined),
      },
      domains: { connect: vi.fn(async () => undefined) },
      publicAccess: { expose: vi.fn(async () => undefined) },
      apiAccess: { rawToken: vi.fn(async () => ({ ip: "10.0.0.8" })) },
      runtime: vi.fn(async () => ({})),
    };
    const support = new CloudComposeSupport({
      builtArtifacts: new Map([
        [
          config.image,
          {
            workspaceId: "workspace-built",
            runtime: { workdir: "/workspace", env: {}, startCommand: "node server.js" },
          },
        ],
      ]),
      workspace: vi.fn(() => builtWorkspace),
      execAndStream: vi.fn(async () => undefined),
    } as never);
    const group = await support.ensureServiceGroup({
      deploymentId: config.deploymentId,
      projectId: config.projectId,
      slug: config.slug,
    });

    await expect(support.deployServiceWorkload(group, config)).resolves.toMatchObject({
      containerId: "workspace-built",
      status: "running",
    });
  });
});

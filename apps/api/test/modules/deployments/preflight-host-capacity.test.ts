/**
 * Deploy preflight's `host-capacity` check: an app's declared `minResources`
 * (catalog) matched against the machine it is about to land on.
 *
 * The three rules that keep it from being a footgun are the ones worth pinning:
 * it only ever refuses a FIRST deploy, an unmeasurable box never refuses, and
 * cloud is skipped entirely (sized from the tier table, and a multi-tenant
 * control plane must not dial a tenant's box to read a number).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_CAPACITY } from "@repo/core";

const { getTemplateForOrg, getTrustedHostCapacity, runCloudPreflight, preflightFn, cloudClient } =
  vi.hoisted(() => ({
    getTemplateForOrg: vi.fn(),
    getTrustedHostCapacity: vi.fn(),
    runCloudPreflight: vi.fn(),
    preflightFn: vi.fn(),
    cloudClient: vi.fn(),
  }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return { ...actual, repos: {} };
});

vi.mock("../../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "desktop" }),
}));

vi.mock("../../../src/lib/cloud/client", () => ({ cloudClient }));
vi.mock("../../../src/lib/cloud/session", () => ({
  isCloudConnectedForOrg: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../src/lib/cloud-preflight", () => ({ runCloudPreflight }));
vi.mock("../../../src/lib/dns-resolver", () => ({
  resolveRecords: vi.fn().mockResolvedValue([]),
  lookupAddresses: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/lib/host-capacity", () => ({ getTrustedHostCapacity }));
vi.mock("../../../src/modules/apps/catalog-source", () => ({ getTemplateForOrg }));

import { runPreflightChecks, PREFLIGHT_ERROR_CODES } from "../../../src/modules/deployments/preflight";

/** A catalog app's snapshot: a compose project, so the framework build fields
 *  (build image / start command) aren't required and `config` passes. */
const snapshot = (over: Record<string, unknown> = {}) =>
  ({
    repoUrl: "",
    localPath: "/srv/posthog",
    branch: "main",
    framework: "docker-compose",
    buildImage: null,
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    port: 8000,
    hasBuild: false,
    hasServer: true,
    deployTarget: "server",
    organizationId: "org-1",
    serverId: "srv-1",
    ...over,
  }) as never;

const opts = (over: Record<string, unknown> = {}) =>
  ({
    ctx: { userId: "user-1", organizationId: "org-1" },
    buildStrategy: "local",
    multiService: true,
    composeServices: [
      {
        kind: "compose",
        name: "web",
        image: "posthog/posthog:latest",
        dependsOn: [],
        environment: {},
        volumes: [],
        exposed: false,
      },
    ],
    appTemplateId: "posthog",
    firstDeploy: true,
    ...over,
  }) as never;

const hungry = { name: "PostHog", minResources: { memoryMb: 8192, cpuCores: 4 } };

const capacityCheck = (result: { checks: { id: string }[] }) =>
  result.checks.find((c) => c.id === "host-capacity");

describe("preflight host-capacity", () => {
  beforeEach(() => {
    getTemplateForOrg.mockReset();
    getTrustedHostCapacity.mockReset();
    runCloudPreflight.mockReset();
    preflightFn.mockReset();
    cloudClient.mockReset();
    preflightFn.mockResolvedValue({ runtime: { ok: true } });
    cloudClient.mockReturnValue({ preflight: preflightFn } as never);
    runCloudPreflight.mockImplementation(async (_userId: string, input: unknown) =>
      preflightFn(input),
    );
    getTemplateForOrg.mockResolvedValue(hungry);
    getTrustedHostCapacity.mockResolvedValue({ cpuCores: 2, memoryMb: 2048, source: "docker" });
  });

  it("refuses a first deploy onto a machine measurably too small", async () => {
    const result = await runPreflightChecks(snapshot(), opts());

    expect(result.ok).toBe(false);
    expect(capacityCheck(result)).toMatchObject({
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.HOST_RESOURCES_INSUFFICIENT,
    });
    // The numbers have to be in the message: AppError serializes only
    // { error, code } — there is no `details` on the wire.
    expect(capacityCheck(result)?.message).toContain("8 GB");
    expect(capacityCheck(result)?.message).toContain("2 GB");
  });

  it("only warns on a redeploy — refusing one would brick an app already running", async () => {
    const result = await runPreflightChecks(snapshot(), opts({ firstDeploy: false }));

    expect(result.ok).toBe(true);
    expect(capacityCheck(result)).toMatchObject({ status: "warn" });
  });

  it("passes when the machine meets the minimum", async () => {
    getTrustedHostCapacity.mockResolvedValue({ cpuCores: 8, memoryMb: 16384, source: "docker" });

    const result = await runPreflightChecks(snapshot(), opts());

    expect(capacityCheck(result)).toMatchObject({ status: "pass" });
  });

  it("never refuses on an unmeasurable box", async () => {
    getTrustedHostCapacity.mockResolvedValue({ ...UNKNOWN_CAPACITY });

    const result = await runPreflightChecks(snapshot(), opts());

    expect(result.ok).toBe(true);
    expect(capacityCheck(result)).toMatchObject({ status: "pass" });
  });

  it("adds no row for an ordinary (non-app) project", async () => {
    const result = await runPreflightChecks(snapshot(), opts({ appTemplateId: null }));

    expect(capacityCheck(result)).toBeUndefined();
    expect(getTemplateForOrg).not.toHaveBeenCalled();
  });

  it("adds no row for an app that declares nothing", async () => {
    getTemplateForOrg.mockResolvedValue({ name: "WordPress" });

    const result = await runPreflightChecks(snapshot(), opts({ appTemplateId: "wordpress" }));

    expect(capacityCheck(result)).toBeUndefined();
    expect(getTrustedHostCapacity).not.toHaveBeenCalled();
  });

  it("skips cloud entirely — tier-sized, and never probes a tenant's box", async () => {
    // serverId has to go too: a snapshot pinned to a server routes over SSH to it
    // regardless of deployTarget (resolveEffectiveTarget is the authority).
    const result = await runPreflightChecks(
      snapshot({ deployTarget: "cloud", serverId: undefined }),
      opts(),
    );

    expect(capacityCheck(result)).toBeUndefined();
    expect(getTrustedHostCapacity).not.toHaveBeenCalled();
  });

  it("trusts a local reading only when the deploy lands on this machine", async () => {
    await runPreflightChecks(snapshot({ deployTarget: "server" }), opts());
    expect(getTrustedHostCapacity).toHaveBeenLastCalledWith("srv-1", "org-1", {
      isLocalTarget: false,
    });

    await runPreflightChecks(snapshot({ deployTarget: "local", serverId: undefined }), opts());
    expect(getTrustedHostCapacity).toHaveBeenLastCalledWith(undefined, "org-1", {
      isLocalTarget: true,
    });
  });

  it("survives an unreadable catalog rather than blocking the deploy", async () => {
    getTemplateForOrg.mockRejectedValue(new Error("catalog overlay unreachable"));

    const result = await runPreflightChecks(snapshot(), opts());

    expect(result.ok).toBe(true);
    expect(capacityCheck(result)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  createServiceRuntimeConfig,
  deploymentForcesImagePull,
  isPreparedLocalImage,
  isStaticHostArtifact,
} from "@repo/platform/engine/modules/deployments/compose/deploy.service";

const project = { id: "project-1", slug: "demo" };
const service = {
  id: "service-api",
  name: "api",
  image: null,
  ports: [],
  volumes: [],
  namespaceVolumes: true,
  environment: {},
  exposed: false,
  dependsOn: [],
  advanced: null,
};

function config(trigger: string, forcePullImages?: boolean) {
  return createServiceRuntimeConfig({
    project: project as never,
    dep: { id: "deployment-1", trigger } as never,
    service: service as never,
    image: "ghcr.io/acme/api:staging",
    environment: {},
    forcePullImages,
  });
}

describe("compose mutable-image pull intent", () => {
  it("force-pulls an incoming webhook image while preserving webhook provenance", () => {
    expect(config("webhook", true).forcePull).toBe(true);
    // The exact same predicate disables whole-project unchanged-image carry
    // forward, so a hook without serviceIds refreshes mutable tags too.
    expect(deploymentForcesImagePull({ trigger: "webhook" } as never, true)).toBe(true);
  });

  it("keeps ordinary webhook deploys pull-if-missing", () => {
    expect(config("webhook").forcePull).toBe(false);
  });

  it("retains the existing update-trigger behavior", () => {
    expect(config("update").forcePull).toBe(true);
  });

  it("does not contact the registry again after the cohort was pre-pulled", () => {
    expect(
      createServiceRuntimeConfig({
        project: project as never,
        dep: { id: "deployment-1", trigger: "webhook" } as never,
        service: service as never,
        image: "ghcr.io/acme/api:staging",
        environment: {},
        forcePullImages: true,
        imageAlreadyPrepared: true,
      }).forcePull,
    ).toBe(false);
  });
});

describe("local image provenance", () => {
  it("trusts an exact image produced or pinned for this service", () => {
    expect(
      isPreparedLocalImage(
        service,
        "openship/api:bld_current",
        new Map([[service.id, "openship/api:bld_current"]]),
      ),
    ).toBe(true);
  });

  it("does not let prior database provenance bypass the daemon availability check", () => {
    // With no current build/pin evidence, Docker must inspect/pull this ref
    // before it removes the live container. A prior success row alone cannot
    // prove that a locally-built image has not since been pruned.
    expect(isPreparedLocalImage(service, "openship/api:bld_previous", undefined)).toBe(false);
  });

  it("rejects cross-service and mismatched current preparation evidence", () => {
    const ref = "openship/api:bld_current";
    expect(isPreparedLocalImage(service, ref, new Map([["another-service", ref]]))).toBe(false);
    expect(
      isPreparedLocalImage(service, ref, new Map([[service.id, "openship/api:bld_other"]])),
    ).toBe(false);
  });
});

describe("static host artifact trust", () => {
  const artifact = "/opt/openship/static/.builds/bld_1-svc_web";

  it("accepts only an exact build-provenance pair under the managed static root", () => {
    expect(
      isStaticHostArtifact(
        "svc-web",
        artifact,
        new Set(["svc-web"]),
        new Map([["svc-web", artifact]]),
      ),
    ).toBe(true);
  });

  it("accepts a prior trusted static release for an env-only refresh", () => {
    const release = "/opt/openship/static/releases/dep_1-svc-web";
    expect(
      isStaticHostArtifact("svc-web", release, new Set(["svc-web"]), new Map(), {
        deploymentId: "dep_1",
        serviceId: "svc-web",
        status: "success",
        imageRef: release,
      }),
    ).toBe(true);
  });

  it("rejects a failed prior row even when its attempted ref matches", () => {
    const attempted = "/opt/openship/static/releases/dep_bad-svc-web";
    expect(
      isStaticHostArtifact("svc-web", attempted, new Set(["svc-web"]), new Map(), {
        deploymentId: "dep_bad",
        serviceId: "svc-web",
        status: "failure",
        imageRef: attempted,
      }),
    ).toBe(false);
  });

  it("rejects a successful row whose path is not its canonical promoted release", () => {
    const configured = "/opt/openship/static/operator-content";
    expect(
      isStaticHostArtifact("svc-web", configured, new Set(["svc-web"]), new Map(), {
        deploymentId: "dep_1",
        serviceId: "svc-web",
        status: "success",
        imageRef: configured,
      }),
    ).toBe(false);
  });

  it("rejects arbitrary, mismatched, and escaping absolute paths", () => {
    const staticIds = new Set(["svc-web"]);
    expect(isStaticHostArtifact("svc-web", "/etc", staticIds, new Map())).toBe(false);
    expect(
      isStaticHostArtifact("svc-web", artifact, staticIds, new Map([["svc-other", artifact]])),
    ).toBe(false);
    expect(
      isStaticHostArtifact(
        "svc-web",
        "/opt/openship/static/../secrets",
        staticIds,
        new Map([["svc-web", "/opt/openship/static/../secrets"]]),
      ),
    ).toBe(false);
  });
});

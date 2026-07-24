import { describe, it, expect } from "vitest";
import type { DockerContainerDetail } from "@repo/adapters";
import type { ManifestProjectEntry } from "../../lib/openship-manifest";
import { reconcileOpenshipProjects, isBuildHelper } from "./docker-reconcile";

describe("isBuildHelper", () => {
  it("is true only for a transient builder (openship.build, no deployment/service)", () => {
    expect(isBuildHelper({ "openship.project": "p", "openship.build": "s1" })).toBe(true);
  });

  it("is FALSE for a real app container that merely inherited openship.build from its bld_ image", () => {
    // The bug: locally-built app containers carry openship.build (image-inherited)
    // but also openship.deployment/service — they are NOT build helpers.
    expect(
      isBuildHelper({
        "openship.project": "p",
        "openship.build": "s1",
        "openship.deployment": "dep_1",
        "openship.service": "svc_1",
      }),
    ).toBe(false);
  });

  it("is false for containers with no openship.build (registry images like redis/postgres)", () => {
    expect(isBuildHelper({ "openship.project": "p" })).toBe(false);
    expect(isBuildHelper({})).toBe(false);
  });
});

function container(over: Partial<DockerContainerDetail> & { labels: Record<string, string> }): DockerContainerDetail {
  return {
    id: over.id ?? "c1",
    name: over.name ?? "svc",
    image: over.image ?? "postgres:17",
    imageId: "sha256:abc",
    state: over.state ?? "running",
    env: over.env ?? [],
    networks: over.networks ?? [],
    mounts: over.mounts ?? [],
    ports: over.ports ?? [],
    ...over,
  };
}

function manifestEntry(over: Partial<ManifestProjectEntry> & { id: string }): ManifestProjectEntry {
  return {
    slug: "slug",
    name: "Name",
    organizationId: "org_1",
    groupId: "app_1",
    domains: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("reconcileOpenshipProjects", () => {
  it("recovers an orphaned project and enriches name/slug/domains from the manifest", () => {
    const details = [
      container({
        id: "c1",
        name: "web",
        image: "myapp:latest",
        labels: { "openship.project": "proj_abc", "openship.service": "web", "openship.deployment": "dep_1" },
      }),
      container({
        id: "c2",
        name: "db",
        labels: { "openship.project": "proj_abc", "openship.service": "db" },
      }),
    ];
    const manifestById = new Map<string, ManifestProjectEntry>([
      ["proj_abc", manifestEntry({ id: "proj_abc", name: "Shop", slug: "shop", domains: ["shop.example.com"] })],
    ]);

    const out = reconcileOpenshipProjects({ managedDetails: details, manifestById, knownHereIds: new Set(), snapshotIds: new Set() });
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p).toMatchObject({ projectId: "proj_abc", knownHere: false, suggestedName: "Shop", slug: "shop" });
    expect(p.domains).toEqual(["shop.example.com"]);
    expect(p.deploymentId).toBe("dep_1");
    expect(p.services.map((s) => s.name).sort()).toEqual(["db", "web"]);
  });

  it("flags a project already present in this DB as knownHere", () => {
    const details = [
      container({ labels: { "openship.project": "proj_known", "openship.service": "web" } }),
    ];
    const out = reconcileOpenshipProjects({
      managedDetails: details,
      manifestById: null,
      knownHereIds: new Set(["proj_known"]),
      snapshotIds: new Set(),
    });
    expect(out[0]!.knownHere).toBe(true);
  });

  it("excludes build-helper containers (openship.build) from services", () => {
    const details = [
      container({ id: "c1", name: "web", labels: { "openship.project": "proj_x", "openship.service": "web" } }),
      container({ id: "c2", name: "build", labels: { "openship.project": "proj_x", "openship.build": "sess_1" } }),
    ];
    const out = reconcileOpenshipProjects({ managedDetails: details, manifestById: null, knownHereIds: new Set(), snapshotIds: new Set() });
    expect(out).toHaveLength(1);
    expect(out[0]!.services).toHaveLength(1);
    expect(out[0]!.services[0]!.name).toBe("web");
  });

  it("falls back to a derived name when no manifest entry exists", () => {
    const details = [
      container({ name: "api", labels: { "openship.project": "proj_deadbeef00", "openship.service": "api" } }),
    ];
    const out = reconcileOpenshipProjects({ managedDetails: details, manifestById: null, knownHereIds: new Set(), snapshotIds: new Set() });
    expect(out[0]!.suggestedName).toBe("openship-deadbeef");
    expect(out[0]!.slug).toBeUndefined();
  });

  it("recovers a single-app container that carries no openship.service label", () => {
    const details = [
      container({ id: "c1", name: "web-1", labels: { "openship.project": "proj_single", "openship.deployment": "dep_9" } }),
    ];
    const out = reconcileOpenshipProjects({ managedDetails: details, manifestById: null, knownHereIds: new Set(), snapshotIds: new Set() });
    expect(out[0]!.services).toHaveLength(1);
    // No service label → the service name falls back to the container name.
    expect(out[0]!.services[0]!.name).toBe("web-1");
  });

  it("ignores containers with no openship.project label", () => {
    const details = [container({ labels: { "openship.network": "shop" } })];
    const out = reconcileOpenshipProjects({ managedDetails: details, manifestById: null, knownHereIds: new Set(), snapshotIds: new Set() });
    expect(out).toEqual([]);
  });
});

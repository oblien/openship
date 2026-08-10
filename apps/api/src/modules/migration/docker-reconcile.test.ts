import { describe, it, expect } from "vitest";
import type { DockerContainerDetail } from "@repo/adapters";
import type { ManifestProjectEntry } from "../../lib/openship-manifest";
import {
  reconcileOpenshipProjects,
  isBuildHelper,
  discoveredServiceName,
  openshipStackName,
  splitEnvByProvenance,
  toDiscoveredService,
} from "./docker-reconcile";
import type { ComposeService } from "../../lib/compose-parser";

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

/**
 * Fixtures captured from a REAL daemon (Docker 29.2.1), image built with
 * `ENV A_IMG=1 / NODE_ENV=production / PORT=3300 / Z_IMG=9`, started four ways.
 * They encode the merge order the split inverts — do not hand-edit: re-capture
 * with `docker inspect <c> --format '{{json .Config.Env}}'`.
 */
const IMG_PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const IMAGE_ENV = [IMG_PATH, "A_IMG=1", "NODE_ENV=production", "PORT=3300", "Z_IMG=9"];
const CAPTURED = {
  // docker run -e NODE_ENV=production -e DB_URL=postgres://x  (NODE_ENV == image default)
  overrideMatchingDefault: [
    "DB_URL=postgres://x",
    "NODE_ENV=production",
    IMG_PATH,
    "A_IMG=1",
    "PORT=3300",
    "Z_IMG=9",
  ],
  // docker run -e PORT=3300  (the ONLY operator var, and it equals the image default)
  soleOverrideMatchingDefault: [
    "PORT=3300",
    IMG_PATH,
    "A_IMG=1",
    "NODE_ENV=production",
    "Z_IMG=9",
  ],
  // docker run (no -e at all) — image env verbatim, in image order
  noOperatorEnv: IMAGE_ENV,
  // docker compose up, environment: {NODE_ENV: production, DB_URL: …, ZZ_LAST: tail}
  compose: [
    "NODE_ENV=production",
    "DB_URL=postgres://x",
    "ZZ_LAST=tail",
    IMG_PATH,
    "A_IMG=1",
    "PORT=3300",
    "Z_IMG=9",
  ],
};

describe("splitEnvByProvenance — inverts Docker's create-time env merge (#394)", () => {
  it("keeps an operator var whose value equals the image default", () => {
    const { userEnv, imageOnly, recovered } = splitEnvByProvenance(
      CAPTURED.overrideMatchingDefault,
      IMAGE_ENV,
    );
    expect(recovered).toBe(true);
    // NODE_ENV is byte-identical to the image default yet WAS set by the operator.
    expect(userEnv).toEqual(["DB_URL=postgres://x", "NODE_ENV=production"]);
    expect(imageOnly).toEqual([IMG_PATH, "A_IMG=1", "PORT=3300", "Z_IMG=9"]);
  });

  it("recovers a single operator var that equals the image default", () => {
    const { userEnv, imageOnly } = splitEnvByProvenance(
      CAPTURED.soleOverrideMatchingDefault,
      IMAGE_ENV,
    );
    expect(userEnv).toEqual(["PORT=3300"]);
    expect(imageOnly).toEqual([IMG_PATH, "A_IMG=1", "NODE_ENV=production", "Z_IMG=9"]);
  });

  it("attributes everything to the image when the operator set nothing", () => {
    // Every boundary fits this shape; the smallest (k=0) is the honest one —
    // taking the largest would import the image's whole toolchain as config.
    const { userEnv, imageOnly } = splitEnvByProvenance(CAPTURED.noOperatorEnv, IMAGE_ENV);
    expect(userEnv).toEqual([]);
    expect(imageOnly).toEqual(IMAGE_ENV);
  });

  it("recovers compose's declared block (compose sends env through the same merge)", () => {
    const { userEnv } = splitEnvByProvenance(CAPTURED.compose, IMAGE_ENV);
    expect(userEnv).toEqual(["NODE_ENV=production", "DB_URL=postgres://x", "ZZ_LAST=tail"]);
  });

  it("reports recovered: false when no boundary fits (non-Docker runtime / image env drifted)", () => {
    // Image-only vars out of image order can't come from the daemon's merge.
    const { userEnv, imageOnly, recovered } = splitEnvByProvenance(
      ["Z_IMG=9", "A_IMG=1", "USER=1"],
      IMAGE_ENV,
    );
    expect(recovered).toBe(false);
    expect(imageOnly).toEqual([]);
    expect(userEnv).toEqual(["Z_IMG=9", "A_IMG=1", "USER=1"]);
  });

  it("treats an image var the operator OVERRODE with a different value as operator config", () => {
    const { userEnv } = splitEnvByProvenance(
      ["NODE_ENV=development", IMG_PATH, "A_IMG=1", "PORT=3300", "Z_IMG=9"],
      IMAGE_ENV,
    );
    expect(userEnv).toEqual(["NODE_ENV=development"]);
  });
});

describe("toDiscoveredService — env import separates operator config from image defaults (#394)", () => {
  it("imports the operator's vars and reports the image-supplied ones with values", () => {
    const detail = container({ labels: {}, env: CAPTURED.overrideMatchingDefault });

    const svc = toDiscoveredService(detail, undefined, IMAGE_ENV);

    // NODE_ENV matches the image default byte-for-byte but the operator set it.
    expect(svc.env).toEqual({ DB_URL: "postgres://x", NODE_ENV: "production" });
    // Left behind, but named WITH values so the wizard can offer a one-click import.
    // PATH is denylisted noise — never config, never offered.
    expect(svc.envImageDefaults).toEqual({ A_IMG: "1", PORT: "3300", Z_IMG: "9" });
    // No longer a warning: env is reported structurally, not as English prose.
    expect(svc.warnings.some((w) => /image default/i.test(w))).toBe(false);
  });

  it("omits envImageDefaults entirely when the image supplied nothing extra", () => {
    const detail = container({ labels: {}, env: ["USER_SET=1"] });
    const svc = toDiscoveredService(detail, undefined, ["FOO=bar"]);
    expect(svc.env).toEqual({ USER_SET: "1" });
    expect(svc.envImageDefaults).toBeUndefined();
  });

  it("keeps a compose-DECLARED key even when provenance can't be recovered", () => {
    // Same unrecoverable shape as above, plus a declared key whose live value
    // equals the image default — the compose file proves it's operator config.
    const detail = container({ labels: {}, env: ["Z_IMG=9", "A_IMG=1", "NODE_ENV=production"] });
    const declared: ComposeService = {
      name: "web",
      environment: { NODE_ENV: "production" },
      ports: [],
      dependsOn: [],
      volumes: [],
    };
    const svc = toDiscoveredService(detail, declared, IMAGE_ENV);
    expect(svc.env.NODE_ENV).toBe("production");
  });

  it("imports a Coolify container's env whole — it sets every var explicitly", () => {
    // Coolify re-sends the image's env verbatim, the one shape provenance can't
    // resolve; the label is the reliable signal, so the split is skipped.
    const detail = container({
      labels: { "coolify.managed": "true" },
      env: CAPTURED.noOperatorEnv,
    });
    const svc = toDiscoveredService(detail, undefined, IMAGE_ENV);
    expect(svc.env).toEqual({
      A_IMG: "1",
      NODE_ENV: "production",
      PORT: "3300",
      Z_IMG: "9",
    });
    expect(svc.envImageDefaults).toBeUndefined();
  });
});

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

describe("discoveredServiceName — migrated container → compose-service mapping", () => {
  it("maps an Openship-deployed container to its openship.service name (no compose label)", () => {
    // The exact same-server migration case: container named openship-openship-web
    // carrying openship.service=web MUST adopt as "web", so the git-compose
    // reconcile updates it in place instead of creating a duplicate bare-name row.
    expect(
      discoveredServiceName(
        {
          name: "openship-openship-web",
          labels: { "openship.project": "p1", "openship.service": "web", "openship.deployment": "d1" },
        },
        undefined,
      ),
    ).toBe("web");
  });

  it("prefers an explicit compose-file declaration over any label", () => {
    expect(
      discoveredServiceName(
        { name: "c", composeService: "api", labels: { "openship.service": "web" } },
        { name: "declared" },
      ),
    ).toBe("declared");
  });

  it("uses the real com.docker.compose.service label before openship.service", () => {
    expect(
      discoveredServiceName({ name: "c", composeService: "db", labels: { "openship.service": "x" } }, undefined),
    ).toBe("db");
  });

  it("falls back to the container name when nothing identifies the service", () => {
    expect(discoveredServiceName({ name: "some-container", labels: {} }, undefined)).toBe("some-container");
    expect(discoveredServiceName({ name: "bare" }, undefined)).toBe("bare");
  });
});

describe("openshipStackName — group Openship-deployed containers by their stack", () => {
  it("derives the stack slug from openship-<slug>-<service>", () => {
    expect(openshipStackName("openship-supabase-kong", "kong")).toBe("supabase");
    expect(openshipStackName("openship-openship-web", "web")).toBe("openship");
    expect(openshipStackName("openship-clincai-api", "api")).toBe("clincai");
  });

  it("handles hyphenated service names via the exact service label", () => {
    // Without the exact label, naive splitting would mis-derive "mongodb-mongo".
    expect(openshipStackName("openship-mongodb-mongo-express", "mongo-express")).toBe("mongodb");
    expect(openshipStackName("openship-mongodb-mongo", "mongo")).toBe("mongodb");
  });

  it("returns null for a non-Openship / unidentifiable container (→ standalone)", () => {
    expect(openshipStackName("my-random-container", undefined)).toBeNull();
    expect(openshipStackName(undefined, "web")).toBeNull();
    // Name that doesn't end in the service label → not our pattern.
    expect(openshipStackName("openship-supabase-kong", "web")).toBeNull();
  });
});

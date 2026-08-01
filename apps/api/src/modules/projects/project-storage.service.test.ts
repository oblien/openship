import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Binding a bucket to a project. The contract:
 *
 *   - nothing is written until the bucket has been PROVED usable (a bind that
 *     "succeeded" against a nonexistent bucket surfaces as a 500 on the user's
 *     first upload, which is the worst place to find out);
 *   - the env var names come from the target's framework, not from a fixed shape;
 *   - values taken from a source app go in as CONNECTIONS (network attach +
 *     dependency graph), everything else as plain env;
 *   - unbinding removes exactly the keys the binding wrote and nothing a user
 *     added by hand;
 *   - rebinding clears the old shape first, so a provider swap can't leave a
 *     stale endpoint behind next to fresh credentials.
 */

const h = vi.hoisted(() => ({
  projects: {} as Record<string, Record<string, unknown> | null>,
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  merges: [] as Array<{ projectId: string; upserts: { key: string; value: string; isSecret?: boolean }[]; deletes: string[] }>,
  connections: [] as Array<{ projectId: string; sourceProjectId: string; outputId: string; envKey: string }>,
  links: [] as Array<{ id: string; envKey: string; sourceProjectId: string }>,
  deletedLinks: [] as string[],
  probe: vi.fn(async () => ({ ok: true }) as { ok: boolean; message?: string }),
  outputs: [] as Array<{ id: string; value: string }>,
  redeploys: [] as string[],
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: vi.fn(async (id: string) => h.projects[id] ?? null),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        h.updates.push({ id, patch });
        h.projects[id] = { ...(h.projects[id] ?? {}), ...patch };
      }),
      listByOrganization: vi.fn(async () => ({ rows: [], total: 0, page: 1, perPage: 20 })),
    },
    projectConnection: { listByTarget: vi.fn(async () => h.links) },
  },
}));
vi.mock("../../lib/permission", () => ({ permission: { assert: vi.fn(async () => {}) } }));
vi.mock("../../lib/connectivity", () => ({ runConnectivityCheck: h.probe }));
vi.mock("../../lib/connectivity-checks", () => ({}));
vi.mock("../../lib/credential-encryption", () => ({
  encryptSecretField: (v: string | null | undefined) => (v ? `enc(${v})` : null),
}));
vi.mock("../../lib/ssrf-guard", () => ({ assertPublicUrl: vi.fn(async () => {}) }));
vi.mock("../apps/app-settings.service", () => ({
  getAppConnectionView: vi.fn(async () => ({ outputs: h.outputs })),
}));
vi.mock("./project-env.service", () => ({
  mergeEnvVars: vi.fn(async (projectId: string, _org: string, patch: { upserts: never[]; deletes: string[] }) => {
    h.merges.push({ projectId, upserts: patch.upserts, deletes: patch.deletes });
  }),
}));
vi.mock("./project-connection.service", () => ({
  createConnection: vi.fn(async (_ctx: unknown, projectId: string, input: { sourceProjectId: string; outputId: string; envKey: string }) => {
    h.connections.push({ projectId, ...input });
    h.links.push({ id: `link_${input.envKey}`, envKey: input.envKey, sourceProjectId: input.sourceProjectId });
  }),
  deleteConnection: vi.fn(async (_ctx: unknown, _projectId: string, linkId: string) => {
    h.deletedLinks.push(linkId);
    h.links = h.links.filter((l) => l.id !== linkId);
  }),
}));
vi.mock("../deployments/build.service", () => ({
  triggerDeployment: vi.fn(async (_ctx: unknown, input: { projectId: string }) => {
    h.redeploys.push(input.projectId);
  }),
}));

import { bindObjectStorage, unbindObjectStorage } from "./project-storage.service";

const ctx = { organizationId: "org1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.updates = [];
  h.merges = [];
  h.connections = [];
  h.links = [];
  h.deletedLinks = [];
  h.redeploys = [];
  h.probe.mockResolvedValue({ ok: true });
  h.outputs = [
    { id: "endpoint", value: "https://minio.example.com" },
    { id: "accessKey", value: "minio" },
    { id: "secretKey", value: "s3cr3t" },
    { id: "bucket", value: "uploads" },
  ];
  h.projects = {
    app: { id: "app", organizationId: "org1", framework: "laravel", activeDeploymentId: "dep_1" },
    store: { id: "store", organizationId: "org1", appTemplateId: "minio" },
  };
});

function envOf(index = 0): Record<string, string> {
  return Object.fromEntries(h.merges[index].upserts.map((v) => [v.key, v.value]));
}

describe("bindObjectStorage — external provider", () => {
  const input = {
    provider: "r2" as const,
    bucket: "media",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: "key",
    secretAccessKey: "secret",
  };

  it("writes the framework's own env names", async () => {
    await bindObjectStorage(ctx, "app", input);
    const env = envOf();
    expect(env.FILESYSTEM_DISK).toBe("s3");
    expect(env.AWS_BUCKET).toBe("media");
    expect(env.AWS_ENDPOINT).toBe("https://acct.r2.cloudflarestorage.com");
    expect(env.AWS_USE_PATH_STYLE_ENDPOINT).toBe("true");
  });

  it("records the binding without the credentials in it", async () => {
    await bindObjectStorage(ctx, "app", input);
    const stored = h.updates.at(-1)!.patch.objectStorage as Record<string, unknown>;
    expect(stored.bucket).toBe("media");
    expect(stored.provider).toBe("r2");
    expect(stored.envKeys).toContain("AWS_SECRET_ACCESS_KEY");
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  it("refuses to write anything when the bucket doesn't check out", async () => {
    h.probe.mockResolvedValue({ ok: false, message: "NoSuchBucket" });
    await expect(bindObjectStorage(ctx, "app", input)).rejects.toThrow(/NoSuchBucket/);
    expect(h.merges).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it("requires an endpoint for a non-AWS provider, but not for AWS", async () => {
    await expect(
      bindObjectStorage(ctx, "app", { ...input, endpoint: "" }),
    ).rejects.toThrow(/endpoint/i);
    await bindObjectStorage(ctx, "app", { ...input, provider: "aws", endpoint: "" });
    const env = envOf();
    expect(env.AWS_ENDPOINT).toBeUndefined();
    expect(env.AWS_USE_PATH_STYLE_ENDPOINT).toBeUndefined();
  });

  it("refuses a bind with no bucket or no credentials", async () => {
    await expect(bindObjectStorage(ctx, "app", { ...input, bucket: "  " })).rejects.toThrow(/bucket/i);
    await expect(
      bindObjectStorage(ctx, "app", { ...input, accessKeyId: "" }),
    ).rejects.toThrow(/access key/i);
  });

  it("refreshes the running container so the env actually reaches it", async () => {
    await bindObjectStorage(ctx, "app", input);
    expect(h.redeploys).toEqual(["app"]);
  });
});

describe("bindObjectStorage — an installed storage app", () => {
  const input = { sourceProjectId: "store", bucket: "uploads", mode: "internal" as const };

  it("takes the endpoint + keys from the app as connections, not plain env", async () => {
    await bindObjectStorage(ctx, "app", input);
    expect(h.connections.map((c) => [c.outputId, c.envKey])).toEqual([
      ["accessKey", "AWS_ACCESS_KEY_ID"],
      ["secretKey", "AWS_SECRET_ACCESS_KEY"],
      ["endpoint", "AWS_ENDPOINT"],
    ]);
    // The rest is plain env — and the credentials must NOT be duplicated there.
    const env = envOf();
    expect(Object.keys(env).sort()).toEqual([
      "AWS_BUCKET",
      "AWS_DEFAULT_REGION",
      "AWS_USE_PATH_STYLE_ENDPOINT",
      "FILESYSTEM_DISK",
    ]);
  });

  it("still records every key it wrote, connections included", async () => {
    await bindObjectStorage(ctx, "app", input);
    const stored = h.updates.at(-1)!.patch.objectStorage as { envKeys: string[]; sourceProjectId: string };
    expect(stored.sourceProjectId).toBe("store");
    expect(stored.envKeys).toContain("AWS_ACCESS_KEY_ID");
    expect(stored.envKeys).toContain("AWS_BUCKET");
  });

  it("says so when the source app hasn't published its endpoint yet", async () => {
    h.outputs = [];
    await expect(bindObjectStorage(ctx, "app", input)).rejects.toThrow(/deploy it first/i);
  });
});

describe("unbindObjectStorage", () => {
  it("removes the connection rows and the plain keys, then clears the marker", async () => {
    await bindObjectStorage(ctx, "app", { sourceProjectId: "store", bucket: "uploads" });
    h.merges = [];

    const res = await unbindObjectStorage(ctx, "app");

    expect(res.removed).toBe(true);
    expect(h.deletedLinks.sort()).toEqual([
      "link_AWS_ACCESS_KEY_ID",
      "link_AWS_ENDPOINT",
      "link_AWS_SECRET_ACCESS_KEY",
    ]);
    // Only the plain keys go through env deletes — the connection deletes own theirs.
    expect(h.merges[0].deletes.sort()).toEqual([
      "AWS_BUCKET",
      "AWS_DEFAULT_REGION",
      "AWS_USE_PATH_STYLE_ENDPOINT",
      "FILESYSTEM_DISK",
    ]);
    expect(h.updates.at(-1)!.patch.objectStorage).toBeNull();
  });

  it("deletes only what the binding recorded, never a hand-set variable", async () => {
    h.projects.app = {
      ...h.projects.app,
      objectStorage: { provider: "aws", bucket: "b", envKeys: ["AWS_BUCKET"], boundAt: "now" },
    };
    await unbindObjectStorage(ctx, "app");
    expect(h.merges[0].deletes).toEqual(["AWS_BUCKET"]);
  });

  it("is a no-op when nothing is bound", async () => {
    const res = await unbindObjectStorage(ctx, "app");
    expect(res.removed).toBe(false);
    expect(h.merges).toHaveLength(0);
  });

  it("a rebind clears the previous shape first", async () => {
    await bindObjectStorage(ctx, "app", {
      provider: "r2",
      bucket: "media",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    h.merges = [];
    // Moving to real AWS drops AWS_ENDPOINT + the path-style flag; leaving them
    // behind would point fresh credentials at the old provider.
    await bindObjectStorage(ctx, "app", {
      provider: "aws",
      bucket: "media",
      accessKeyId: "k2",
      secretAccessKey: "s2",
    });
    const deletes = h.merges.flatMap((m) => m.deletes);
    expect(deletes).toContain("AWS_ENDPOINT");
    expect(deletes).toContain("AWS_USE_PATH_STYLE_ENDPOINT");
    const stored = h.updates.at(-1)!.patch.objectStorage as { envKeys: string[] };
    expect(stored.envKeys).not.toContain("AWS_ENDPOINT");
  });
});

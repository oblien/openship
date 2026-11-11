import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const provider = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.auth", async (original) => ({
  ...(await original<object>()),
  githubFetch: provider.fetch,
}));
import { sourceFixture, sourceClients } from "../../helpers/runtime-source";
import { db, schema, repos, seedOwner } from "../jobs/_harness";

const selection = { path: "Dockerfile", format: "dockerfile" as const };
it("retains JSON Compose formatting and rejects read-only credentials at publication", async () => {
  const content = '{\n  "services": { "api": { "image": "node:22" } }\n}\n';
  const f = await sourceFixture({ "compose.json": content });
  provider.fetch.mockImplementation(f.fetch);
  const edit = {
    path: "compose.json",
    format: "compose" as const,
    baseSha: f.git.head,
    referenceId: "service:api",
    image: "node:24",
  };
  const c = await sourceClients(f.owner, f.owner.orgId, {
    credential: { organizationId: f.owner.orgId, readOnly: true },
  });
  const preview = await c.native.updates.previewRuntimeSource(f.project.id, edit);
  expect(preview.after).toBe(content.replace("node:22", "node:24"));
  await expect(
    c.native.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
  expect(f.git.writes).toEqual([]);
});
it("uses the same reviewed change and draft PR publisher through native and HTTP operations", async () => {
  const f = await sourceFixture();
  provider.fetch.mockImplementation(f.fetch);
  for (const c of [f.clients.native, f.clients.remote]) {
    const source = await c.updates.runtimeSource(f.project.id, selection);
    const edit = {
      ...selection,
      baseSha: source.baseSha,
      referenceId: source.references[0]!.id,
      image: "node:22.23.4-alpine",
    };
    const preview = await c.updates.previewRuntimeSource(f.project.id, edit);
    expect(preview.after).toBe(f.git.files.Dockerfile!.replace("22.23.3", "22.23.4"));
    const result = await c.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    });
    expect(result.pullRequestUrl).toBe("https://github.com/acme/app/pull/42");
    expect(f.git.writes.at(-1)?.params).toMatchObject({
      draft: true,
      base: "main",
      maintainer_can_modify: false,
    });
    expect(f.git.head).toBe(source.baseSha);
    expect((await repos.project.findById(f.project.id))!.activeDeploymentId).toBeNull();
  }
});
it("rejects branch changes, forged reviews and foreign service IDs before any write", async () => {
  const f = await sourceFixture();
  provider.fetch.mockImplementation(f.fetch);
  const source = await f.clients.remote.updates.runtimeSource(f.project.id, selection);
  const edit = {
    ...selection,
    baseSha: source.baseSha,
    referenceId: source.references[0]!.id,
    image: "node:22.23.4-alpine",
  };
  const preview = await f.clients.remote.updates.previewRuntimeSource(f.project.id, edit);
  await expect(
    f.clients.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: "f".repeat(64),
      requestId: randomUUID(),
    }),
  ).rejects.toBeDefined();
  await expect(
    f.clients.remote.updates.runtimeSource(f.project.id, {
      ...selection,
      serviceId: "other-project-service",
    }),
  ).rejects.toBeDefined();
  f.git.head = "e".repeat(40);
  await expect(
    f.clients.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    }),
  ).rejects.toBeDefined();
  expect(f.git.writes).toEqual([]);
});
it("requires project membership and file content/write grants even for a project editor", async () => {
  const f = await sourceFixture();
  provider.fetch.mockImplementation(f.fetch);
  provider.fetch.mockClear();
  const outsider = await sourceClients(await seedOwner());
  await expect(
    outsider.remote.updates.runtimeSource(f.project.id, selection),
  ).rejects.toBeDefined();
  expect(provider.fetch).not.toHaveBeenCalled();
  const member = await seedOwner({ bound: false });
  await db.insert(schema.member).values({
    id: randomUUID(),
    organizationId: f.owner.orgId,
    userId: member.userId,
    role: "restricted",
  });
  for (const [resourceType, resourceId, scope] of [
    ["project", f.project.id, null],
    ["github_repository", "acme/app", { v: 1, read: { paths: ["src/**"] } }],
  ] as const)
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: member.userId,
      resourceType,
      resourceId,
      permissions: ["read", "write"],
      scope,
      grantedByUserId: f.owner.userId,
    });
  const c = await sourceClients(member, f.owner.orgId);
  await expect(c.remote.updates.runtimeSource(f.project.id, selection)).rejects.toBeDefined();
  expect(provider.fetch.mock.calls.some(([call]) => call.url.includes("/contents/"))).toBe(false);
  // Grant content only. Viewing a diff does not authorize publishing it.
  await repos.resourceGrant.upsert({
    organizationId: f.owner.orgId,
    userId: member.userId,
    resourceType: "github_repository",
    resourceId: "acme/app",
    permissions: ["read", "write"],
    scope: { v: 1, read: { paths: ["Dockerfile"] }, write: { paths: [] } },
    grantedByUserId: f.owner.userId,
  });
  const edit = {
    ...selection,
    baseSha: f.git.head,
    referenceId: "from:1",
    image: "node:22.23.4-alpine",
  };
  const preview = await c.remote.updates.previewRuntimeSource(f.project.id, edit);
  await expect(
    c.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    }),
  ).rejects.toBeDefined();
  expect(f.git.writes).toEqual([]);
});

it("reports GitHub access before publication, rechecks after reconnection, and never writes while denied", async () => {
  const { GitHubApiError } = await import("@repo/platform/engine/modules/github/github.error");
  const f = await sourceFixture();
  let denied = true;
  provider.fetch.mockImplementation((input) => {
    if (denied && input.url.endsWith("/repos/acme/app"))
      throw new GitHubApiError(403, "Resource not accessible by integration", new Headers());
    return f.fetch(input);
  });
  const source = await f.clients.remote.updates.runtimeSource(f.project.id, selection);
  expect(source.publishAccess).toBe("github_access_required");
  const edit = {
    ...selection,
    baseSha: source.baseSha,
    referenceId: source.references[0]!.id,
    image: "node:24",
  };
  const preview = await f.clients.remote.updates.previewRuntimeSource(f.project.id, edit);
  await expect(
    f.clients.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "REPOSITORY_GITHUB_ACCESS_REQUIRED" });
  expect(f.git.writes).toEqual([]);
  denied = false;
  expect(
    (await f.clients.remote.updates.runtimeSource(f.project.id, selection)).publishAccess,
  ).toBe("available");
  await f.clients.remote.updates.publishRuntimeSource(f.project.id, {
    ...edit,
    reviewId: preview.reviewId,
    requestId: randomUUID(),
  });
  expect(f.git.writes.at(-1)?.path).toBe("/pulls");
});

it("does not report rate limits or outages as missing permissions", async () => {
  const { GitHubApiError } = await import("@repo/platform/engine/modules/github/github.error");
  const f = await sourceFixture();
  for (const error of [
    new GitHubApiError(
      403,
      "API rate limit exceeded",
      new Headers({ "x-ratelimit-remaining": "0" }),
    ),
    new GitHubApiError(503, "Service unavailable", new Headers()),
  ]) {
    provider.fetch.mockImplementation((input) => {
      if (input.url.endsWith("/repos/acme/app")) throw error;
      return f.fetch(input);
    });
    await expect(f.clients.native.updates.runtimeSource(f.project.id, selection)).rejects.toThrow();
    expect(f.git.writes).toEqual([]);
  }
});

it("preserves the branch and returns explicit recovery when GitHub revokes PR writes after preflight", async () => {
  const { GitHubApiError } = await import("@repo/platform/engine/modules/github/github.error");
  const f = await sourceFixture();
  provider.fetch.mockImplementation((input) => {
    if (input.method === "POST" && input.url.endsWith("/pulls"))
      throw new GitHubApiError(
        403,
        "Resource not accessible by personal access token",
        new Headers(),
      );
    return f.fetch(input);
  });
  const source = await f.clients.remote.updates.runtimeSource(f.project.id, selection);
  const edit = {
    ...selection,
    baseSha: source.baseSha,
    referenceId: source.references[0]!.id,
    image: "node:24",
  };
  const preview = await f.clients.remote.updates.previewRuntimeSource(f.project.id, edit);
  const requestId = randomUUID();
  await expect(
    f.clients.remote.updates.publishRuntimeSource(f.project.id, {
      ...edit,
      reviewId: preview.reviewId,
      requestId,
    }),
  ).rejects.toMatchObject({ code: "REPOSITORY_PR_ACCESS_REQUIRED" });
  expect(f.git.refs).toEqual(new Set([`refs/heads/openship/changes/${requestId}`]));
  expect(f.git.head).toBe(source.baseSha);
});

it("reports archived repositories and read-only workspace credentials without claiming they are publishable", async () => {
  const f = await sourceFixture();
  provider.fetch.mockImplementation((input) =>
    input.url.endsWith("/repos/acme/app")
      ? { archived: true, permissions: { push: true } }
      : f.fetch(input),
  );
  expect(
    (await f.clients.remote.updates.runtimeSource(f.project.id, selection)).publishAccess,
  ).toBe("repository_read_only");
  const client = await sourceClients(f.owner, f.owner.orgId, {
    credential: { organizationId: f.owner.orgId, readOnly: true },
  });
  expect((await client.native.updates.runtimeSource(f.project.id, selection)).publishAccess).toBe(
    "workspace_access_required",
  );
  expect(f.git.writes).toEqual([]);
});

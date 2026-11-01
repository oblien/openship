import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capabilitiesImpliedBy,
  capabilityFor,
  CAPABILITIES,
  type GrantPermission,
} from "@repo/core";
import {
  createAuthorization,
  createDomainOperations,
  grantPermits,
  type Authorization,
  type DomainDependencies,
  type ExecutionContext,
} from "../src";
import { alice, authorizationFixture } from "./fixtures";
import { domainFixture } from "../../contracts/test/fixtures";

describe("capability mapping", () => {
  it("maps route tags onto capabilities, and only for areas that define them", () => {
    expect(capabilityFor("domain", "read")).toBe("domains:read");
    expect(capabilityFor("domain", "write")).toBe("domains:write");
    expect(capabilityFor("domain", "admin")).toBe("domains:delete");
    expect(capabilityFor("deployment", "read")).toBe("deployments:read");
    expect(capabilityFor("deployment", "write")).toBe("deployments:trigger");
    // Deleting a deployment and everything outside the two areas stay coarse.
    expect(capabilityFor("deployment", "admin")).toBeNull();
    expect(capabilityFor("project", "write")).toBeNull();
    expect(capabilityFor("service", "write")).toBeNull();
  });

  it("expands coarse levels to the capabilities they already implied", () => {
    expect(capabilitiesImpliedBy(["read"])).toEqual(["domains:read", "deployments:read"]);
    expect(capabilitiesImpliedBy(["read", "write"])).toEqual([
      "domains:read",
      "domains:write",
      "deployments:read",
      "deployments:trigger",
    ]);
    expect(capabilitiesImpliedBy(["admin"])).toEqual([...CAPABILITIES]);
    expect(capabilitiesImpliedBy(["create"])).toEqual([]);
  });

  it("agrees with the enforcement check for every capability and coarse level", () => {
    // A coarse level and the capability set it expands to authorize the same checks.
    for (const level of [
      ["read"],
      ["read", "write"],
      ["read", "write", "admin"],
    ] as GrantPermission[][]) {
      for (const capability of CAPABILITIES) {
        const [area] = capability.split(":");
        const resourceType = area === "domains" ? "domain" : "deployment";
        for (const action of ["read", "write", "admin"] as const) {
          if (capabilityFor(resourceType, action) !== capability) continue;
          const input = { resourceType, resourceId: "x", action } as const;
          expect(grantPermits(level, input), `${level} ${capability}`).toBe(
            grantPermits(capabilitiesImpliedBy(level), input),
          );
        }
      }
    }
  });
});

let state: ReturnType<typeof authorizationFixture>;
let auth: Authorization;
let token: ExecutionContext;
let domains: ReturnType<typeof createDomainOperations>;
const list = vi.fn(),
  create = vi.fn(),
  get = vi.fn(),
  verify = vi.fn(),
  remove = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-a" });
  state.domains.set("domain-a", { projectId: "project-a" });
  state.domains.set("domain-b", { projectId: "project-b" });
  state.deployments.set("deployment-a", { projectId: "project-a" });
  auth = createAuthorization(state);
  token = await auth.resolveScope(
    {
      ...alice,
      tokenScope: { tokenId: "token-a" },
      credential: { organizationId: "org-a", readOnly: false },
    },
    "org-a",
  );
  list.mockResolvedValue([domainFixture()]);
  create.mockResolvedValue({ domain: domainFixture(), records: { mode: "external", records: [] } });
  get.mockResolvedValue(domainFixture());
  verify.mockResolvedValue({ verified: true, cnameVerified: true, txtVerified: true });
  remove.mockResolvedValue({ message: "domain removed" });
  domains = createDomainOperations(auth, {
    collection: { list, create },
    resources: { get, verify, remove },
    scoped: {},
    subscribe: () => () => ({ success: true, unsubscribe: () => {} }),
  } as unknown as DomainDependencies);
});

const grant = (id: string, permissions: GrantPermission[]) =>
  state.tokenGrants.set(`token-a:project:${id}`, { permissions });
const allowed = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

/** The domain routes on project-a: list/add check the project, the rest the domain. */
async function domainRoutes() {
  return {
    list: await allowed(domains.list(token, "project-a")),
    add: await allowed(domains.create(token, "project-a", { hostname: "app.example.com" })),
    get: await allowed(domains.get(token, "domain-a")),
    verify: await allowed(domains.verify(token, "domain-a")),
    delete: await allowed(domains.remove(token, "domain-a")),
  };
}
const none = { list: false, add: false, get: false, verify: false, delete: false };

describe("domain routes under each capability", () => {
  it("denies every route without a grant", async () => {
    expect(await domainRoutes()).toEqual(none);
  });

  it.each([
    [["domains:read"], { list: true, add: false, get: true, verify: false, delete: false }],
    [["domains:write"], { list: false, add: true, get: false, verify: true, delete: false }],
    [["domains:delete"], { list: false, add: false, get: false, verify: false, delete: true }],
    [
      ["domains:read", "domains:write", "domains:delete"],
      { list: true, add: true, get: true, verify: true, delete: true },
    ],
  ] as [GrantPermission[], typeof none][])("%j", async (permissions, expected) => {
    grant("project-a", permissions);
    expect(await domainRoutes()).toEqual(expected);
  });

  it("a domains-only grant reaches nothing else on the project and no other project", async () => {
    grant("project-a", ["domains:read", "domains:write", "domains:delete"]);
    for (const action of ["read", "write", "admin"] as const) {
      expect(
        await auth.checkPermissionOnResource(token, {
          resourceType: "project",
          resourceId: "project-a",
          action,
        }),
      ).toBe(false);
    }
    expect(
      await auth.checkPermissionOnResource(token, {
        resourceType: "deployment",
        resourceId: "deployment-a",
        action: "read",
      }),
    ).toBe(false);
    await expect(domains.remove(token, "domain-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(domains.list(token, "project-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(remove).toHaveBeenCalledTimes(0);
  });
});

describe("old coarse grants keep working", () => {
  it.each([
    [["read"], { list: true, add: false, get: true, verify: false, delete: false }],
    [["read", "write"], { list: true, add: true, get: true, verify: true, delete: false }],
    [["write"], { list: true, add: true, get: true, verify: true, delete: false }],
    [["admin"], { list: true, add: true, get: true, verify: true, delete: true }],
  ] as [GrantPermission[], typeof none][])("project %j", async (permissions, expected) => {
    grant("project-a", permissions);
    expect(await domainRoutes()).toEqual(expected);
  });

  it("a coarse level plus one capability adds exactly that capability", async () => {
    grant("project-a", ["read", "write", "domains:delete"]);
    expect(await domainRoutes()).toEqual({
      list: true,
      add: true,
      get: true,
      verify: true,
      delete: true,
    });
    expect(
      await auth.checkPermissionOnResource(token, {
        resourceType: "project",
        resourceId: "project-a",
        action: "admin",
      }),
    ).toBe(false);
  });
});

describe("deployments use the same model", () => {
  const check = (
    action: "read" | "write" | "admin",
    input: Partial<{
      resourceType: "deployment" | "project";
      resourceId: string;
      capability: "deployments:trigger";
    }> = {},
  ) =>
    auth.checkPermissionOnResource(token, {
      resourceType: "deployment",
      resourceId: "deployment-a",
      action,
      ...input,
    });

  it("deployments:read reads deployments; deployments:trigger runs them; delete stays admin", async () => {
    grant("project-a", ["deployments:read"]);
    expect(await check("read")).toBe(true);
    expect(await check("write")).toBe(false);
    grant("project-a", ["deployments:trigger"]);
    expect(await check("write")).toBe(true);
    // POST /api/deployments checks the project on behalf of the deploy.
    expect(
      await check("write", {
        resourceType: "project",
        resourceId: "project-a",
        capability: "deployments:trigger",
      }),
    ).toBe(true);
    expect(await check("write", { resourceType: "project", resourceId: "project-a" })).toBe(false);
    expect(await check("admin")).toBe(false);
    // Domain capabilities never satisfy a deployment check, or the reverse.
    grant("project-a", ["domains:read", "domains:write", "domains:delete"]);
    expect(await check("read")).toBe(false);
  });
});

describe("explicit parent capability invariants", () => {
  it("never lets a read capability stand in for an admin action or another resource tree", () => {
    expect(grantPermits(["domains:read"], { resourceType: "project", resourceId: "project-a", action: "admin", capability: "domains:read" })).toBe(false);
    expect(grantPermits(["domains:read"], { resourceType: "server", resourceId: "server-a", action: "read", capability: "domains:read" })).toBe(false);
  });
});

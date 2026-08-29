import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "../../../src/lib/secret-env";

/**
 * #336 response-contract guard. The prior gap was that NO test drove a handler
 * and asserted the response is masked — so `create()` shipped unmasked and the
 * suite stayed green. This drives the real controller handlers (keeping the real
 * presentDeployment/presentDeployments, stubbing only the data fetch) and asserts
 * the secret never appears in the serialized response. A future handler that
 * returns a raw deployment row fails here.
 */

const SECRET = "s3cr3t-token-value";

const { getDeployment, listDeployments } = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  listDeployments: vi.fn(),
}));

// Keep the REAL presenters; stub only the DB-backed fetchers.
vi.mock("../../../src/modules/deployments/deployment.service", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/modules/deployments/deployment.service")>();
  return { ...actual, getDeployment, listDeployments };
});

// Cut the controller's heavy sibling import chain (build.service → auth →
// provision-user → @repo/db.schema, plus adapters) — the list/getById handlers
// under test don't touch any of these.
vi.mock("@repo/db", () => ({ repos: {}, schema: {} }));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("../../../src/modules/deployments/reconcile.service", () => ({ triggerReconcile: vi.fn() }));
vi.mock("../../../src/modules/deployments/build.service", () => ({ triggerDeployment: vi.fn(), subscribeToBuildSession: vi.fn() }));
vi.mock("../../../src/modules/deployments/build-status.service", () => ({}));
vi.mock("../../../src/modules/deployments/ssl.service", () => ({}));
vi.mock("../../../src/modules/deployments/prepare.service", () => ({ resolveProjectInfo: vi.fn() }));
vi.mock("../../../src/modules/projects/transfer.service", () => ({ promoteProjectToCloud: vi.fn(), TransferConflictError: class extends Error {} }));
vi.mock("../../../src/lib/cloud/project-router", () => ({
  maybeProxyCloudProject: vi.fn().mockResolvedValue(null),
  proxyToSaaS: vi.fn(),
}));
// deployment.service's own transitive deps (pulled by importActual).
vi.mock("../../../src/modules/projects/project-cleanup.service", () => ({ collectDeploymentManifest: vi.fn(), executeCleanup: vi.fn() }));
vi.mock("../../../src/modules/github/github-access", () => ({ assertGitHubRepoAccess: vi.fn() }));
vi.mock("../../../src/modules/deployments/rollback", () => ({ rollback: vi.fn(), setPin: vi.fn() }));
vi.mock("../../../src/lib/deployment-runtime", () => ({ resolveDeploymentRuntime: vi.fn() }));

import { getById, list } from "../../../src/modules/deployments/deployment.controller";

const depWithSecret = (id: string) => ({
  id,
  status: "ready",
  meta: {
    previousActiveDeploymentId: "dep_0",
    composeServices: [
      { name: "web", environment: { API_TOKEN: SECRET, NODE_ENV: "production" } },
      { name: "db", environment: { POSTGRES_PASSWORD: SECRET } },
    ],
  },
});

function ctx(params: Record<string, string> = {}, query: Record<string, string> = {}) {
  let captured: unknown;
  const c = {
    req: {
      param: (n: string) => params[n],
      query: (n: string) => query[n],
    },
    json: (obj: unknown) => {
      captured = obj;
      return obj as never;
    },
    get: () => ({ organizationId: "org-1", userId: "u1" }),
  } as any;
  return { c, read: () => captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#336 deployment controller masks env in responses", () => {
  it("getById masks meta.composeServices[].environment", async () => {
    getDeployment.mockResolvedValue(depWithSecret("dep_1"));
    const { c, read } = ctx({ id: "dep_1" });
    await getById(c);
    const body = read() as any;
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.data.meta.composeServices[0].environment.API_TOKEN).toBe(ENV_MASK);
    expect(body.data.meta.composeServices[0].environment.NODE_ENV).toBe(ENV_MASK);
    expect(body.data.meta.composeServices[1].environment.POSTGRES_PASSWORD).toBe(ENV_MASK);
    // non-env meta preserved
    expect(body.data.meta.previousActiveDeploymentId).toBe("dep_0");
  });

  it("list masks every row's compose env", async () => {
    listDeployments.mockResolvedValue({
      rows: [depWithSecret("dep_1"), depWithSecret("dep_2")],
      total: 2,
      page: 1,
      perPage: 50,
    });
    const { c, read } = ctx();
    await list(c);
    const body = read() as any;
    expect(JSON.stringify(body)).not.toContain(SECRET);
    for (const row of body.data) {
      for (const svc of row.meta.composeServices) {
        for (const v of Object.values(svc.environment)) expect(v).toBe(ENV_MASK);
      }
    }
  });
});

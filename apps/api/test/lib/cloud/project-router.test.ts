import { beforeEach, describe, expect, it, vi } from "vitest";

// The cloud gateway is the SINGLE place local↔cloud routing happens, so its
// leak-critical properties are unit-tested here:
//   - proxyToSaaS forwards ONLY method/path/body + Content-Type — never an
//     inbound identity header (X-Organization-Id, cookies). The SaaS resolves
//     the org from the owner bearer; forwarding a local org id would be a leak.
//   - resolveProjectSource routes correctly (hint, local-row, cloud-link).
//   - a missing transport result maps to 503 (not 200/500).

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn() },
    deployment: { findById: vi.fn() },
    domain: { findById: vi.fn() },
  },
}));
vi.mock("@repo/platform/engine/config/index", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: { authorize: vi.fn() } }));
vi.mock("../../../src/lib/request-context", () => ({ getRequestContext: vi.fn(() => ({ organizationId: "org1", scopeMode: "resource" })) }));
vi.mock("@repo/platform/engine/lib/cloud/transport", () => ({
  cloudFetchAsOrgOwner: vi.fn(),
  resolveOrgCloudUserId: vi.fn(),
}));

import { resolveProjectSource, proxyToSaaS, cloudProjectProxyByQuery } from "../../../src/lib/cloud/project-router";
import { authorization } from "@repo/platform/engine/lib/authorization";
import { repos } from "@repo/db";
import { env } from "@repo/platform/engine/config/index";
import { getRequestContext } from "../../../src/lib/request-context";
import {
  cloudFetchAsOrgOwner,
  resolveOrgCloudUserId,
} from "@repo/platform/engine/lib/cloud/transport";

function fakeCtx(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const headers = opts.headers ?? {};
  return {
    req: {
      url: opts.url ?? "http://localhost/api/projects/p1",
      method: opts.method ?? "GET",
      query: (name: string) => new URL(opts.url ?? "http://localhost/api/projects/p1").searchParams.get(name) ?? undefined,
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      text: async () => opts.body ?? "",
    },
    set: vi.fn(),
    json: (obj: unknown, status?: number) =>
      new Response(JSON.stringify(obj), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  } as never;
}

describe("resolveProjectSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (env as { CLOUD_MODE: boolean }).CLOUD_MODE = false;
  });

  it("is always 'local' on the SaaS itself (CLOUD_MODE)", async () => {
    (env as { CLOUD_MODE: boolean }).CLOUD_MODE = true;
    expect(await resolveProjectSource(fakeCtx({}), "p1", "org1")).toBe("local");
    expect(repos.project.findById).not.toHaveBeenCalled();
  });

  it("resolves a Cloud hint through the same authority check", async () => {
    const c = fakeCtx({ headers: { "x-project-source": "cloud" } });
    vi.mocked(repos.project.findById).mockResolvedValue(undefined);
    vi.mocked(resolveOrgCloudUserId).mockResolvedValue("owner1");
    expect(await resolveProjectSource(c, "p1", "org1")).toBe("cloud");
    expect(repos.project.findById).toHaveBeenCalledWith("p1");
  });

  it("never overrides a local record or DB failure with a Cloud hint", async () => {
    const c = fakeCtx({ headers: { "x-project-source": "cloud" } });
    vi.mocked(repos.project.findById).mockResolvedValue({ id: "p1" } as never);
    expect(await resolveProjectSource(c, "p1", "org1")).toBe("local");
    vi.mocked(repos.project.findById).mockRejectedValue(new Error("DB offline"));
    await expect(resolveProjectSource(c, "p1", "org1")).rejects.toThrow("DB offline");
  });

  it("honors the local hint", async () => {
    const c = fakeCtx({ headers: { "x-project-source": "local" } });
    expect(await resolveProjectSource(c, "p1", "org1")).toBe("local");
  });

  it("resolves a present local row as local", async () => {
    (repos.project.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "p1" });
    expect(await resolveProjectSource(fakeCtx({}), "p1", "org1")).toBe("local");
  });

  it("resolves a local miss + cloud link as cloud", async () => {
    (repos.project.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (resolveOrgCloudUserId as ReturnType<typeof vi.fn>).mockResolvedValue("owner1");
    expect(await resolveProjectSource(fakeCtx({}), "p1", "org1")).toBe("cloud");
  });

  it("resolves a local miss + NO cloud link as not-found (IDOR-safe)", async () => {
    (repos.project.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (resolveOrgCloudUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await resolveProjectSource(fakeCtx({}), "p1", "org1")).toBe("not-found");
  });
});

describe("proxyToSaaS", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (env as { CLOUD_MODE: boolean }).CLOUD_MODE = false;
  });

  it("refuses fixed tenant forwarding before acquiring or sending an owner credential", async () => {
    vi.mocked(getRequestContext).mockReturnValueOnce({ organizationId: "org1", scopeMode: "fixed" } as never);
    await expect(proxyToSaaS(fakeCtx({}), "org1")).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(cloudFetchAsOrgOwner).not.toHaveBeenCalled();
  });

  it.each([
    { credential: { organizationId: "org1", readOnly: false } },
    { tokenScope: { tokenId: "restricted-token" } },
  ])("refuses credential-scoped forwarding even without a fixed request: %j", async restriction => {
    vi.mocked(getRequestContext).mockReturnValueOnce({ organizationId: "org1", scopeMode: "resource", ...restriction } as never);
    vi.mocked(cloudFetchAsOrgOwner).mockResolvedValue(Response.json({ ok: true }));
    await expect(proxyToSaaS(fakeCtx({}), "org1")).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(cloudFetchAsOrgOwner).not.toHaveBeenCalled();
  });

  it("forwards method/path/body but NEVER an identity header", async () => {
    (cloudFetchAsOrgOwner as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const c = fakeCtx({
      url: "http://localhost/api/projects/p1/env?environment=prod",
      method: "PATCH",
      headers: {
        "x-organization-id": "org-local",
        "content-type": "application/json",
        cookie: "openship-session=secret",
      },
      body: JSON.stringify({ a: 1 }),
    });

    const res = await proxyToSaaS(c, "org-saas");
    expect(res.status).toBe(200);
    expect(cloudFetchAsOrgOwner).toHaveBeenCalledTimes(1);

    const [org, path, init] = (cloudFetchAsOrgOwner as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(org).toBe("org-saas");
    expect(path).toBe("/api/projects/p1/env?environment=prod");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));

    // CRITICAL no-leak assertions: only content-type forwarded; no org id, no cookie.
    const fwdKeys = Object.keys((init.headers ?? {}) as Record<string, string>).map((k) =>
      k.toLowerCase(),
    );
    expect(fwdKeys).not.toContain("x-organization-id");
    expect(fwdKeys).not.toContain("cookie");
    expect(fwdKeys).toEqual(["content-type"]);
  });

  it("maps a null transport result to 503 CLOUD_UNREACHABLE (not 200/500)", async () => {
    (cloudFetchAsOrgOwner as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await proxyToSaaS(
      fakeCtx({ url: "http://localhost/api/projects/p1", method: "GET" }),
      "org-saas",
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("CLOUD_UNREACHABLE");
  });
});

describe("deployment collection gateway capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (env as { CLOUD_MODE: boolean }).CLOUD_MODE = false;
  });
  it("keeps the checked deployment capability when the project collection passes through the gateway", async () => {
    vi.mocked(authorization.authorize).mockResolvedValue({ organizationId: "org1" } as never);
    vi.mocked(repos.project.findById).mockResolvedValue({ id: "p1", organizationId: "org1" } as never);
    const next = vi.fn();
    await cloudProjectProxyByQuery(fakeCtx({ url: "http://localhost/api/deployments?projectId=p1" }), next, "deployments:read");
    expect(authorization.authorize).toHaveBeenCalledWith(expect.anything(), { resourceType: "project", resourceId: "p1", action: "read", capability: "deployments:read" });
    expect(next).toHaveBeenCalledOnce();
  });
  it("never uses an owner's Cloud credential for a locally scoped capability token", async () => {
    vi.mocked(authorization.authorize).mockResolvedValue({ organizationId: "org1", scopeMode: "fixed", tokenScope: { tokenId: "token" }, role: "restricted" } as never);
    vi.mocked(getRequestContext).mockReturnValue({ organizationId: "org1", scopeMode: "fixed", tokenScope: { tokenId: "token" }, role: "restricted" } as never);
    vi.mocked(repos.project.findById).mockResolvedValue(undefined);
    vi.mocked(resolveOrgCloudUserId).mockResolvedValue("owner1");
    const next = vi.fn();
    await expect(cloudProjectProxyByQuery(fakeCtx({ url: "http://localhost/api/deployments?projectId=p1" }), next, "deployments:read")).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(cloudFetchAsOrgOwner).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

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
vi.mock("../../../src/lib/request-context", () => ({ getRequestContext: vi.fn(() => ({ organizationId: "org1", scopeMode: "resource" })) }));
vi.mock("@repo/platform/engine/lib/cloud/transport", () => ({
  cloudFetchAsOrgOwner: vi.fn(),
  resolveOrgCloudUserId: vi.fn(),
}));

import { resolveProjectSource, proxyToSaaS } from "../../../src/lib/cloud/project-router";
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
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      text: async () => opts.body ?? "",
    },
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

  it("honors the X-Project-Source: cloud hint without a DB read", async () => {
    const c = fakeCtx({ headers: { "x-project-source": "cloud" } });
    expect(await resolveProjectSource(c, "p1", "org1")).toBe("cloud");
    expect(repos.project.findById).not.toHaveBeenCalled();
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
    vi.clearAllMocks();
    (env as { CLOUD_MODE: boolean }).CLOUD_MODE = false;
  });

  it("refuses fixed tenant forwarding before acquiring or sending an owner credential", async () => {
    vi.mocked(getRequestContext).mockReturnValueOnce({ organizationId: "org1", scopeMode: "fixed" } as never);
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

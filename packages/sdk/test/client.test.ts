import { describe, expect, it, vi } from "vitest";
import { ApiError, OpenshipClient } from "../src/client";
import { SDK_CAPABILITIES } from "@repo/contracts";
import { deploymentFixture } from "../../contracts/test/fixtures";

const response = () =>
  Response.json(
    {
      data: {
        deployment_id: "dep-project-a",
        project_id: "project-a",
        deployment: deploymentFixture(),
      },
    },
    { status: 202 },
  );
const scopedFetch = () =>
  vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith("/health") ? Response.json({ sdk: SDK_CAPABILITIES }) : response(),
  );

describe("remote SDK", () => {
  it.each([
    "https://ship.example.test",
    "https://ship.example.test/",
    "https://ship.example.test/api/",
  ])("uses the same deployment command and the selected tenant at %s", async (baseUrl) => {
    const fetcher = scopedFetch();
    const client = new OpenshipClient({
      baseUrl,
      token: "credential",
      organizationId: "org-a",
      fetch: fetcher,
    });
    const result = await client.deployments.create({
      projectId: "project-a",
      forceAll: true,
      reuseSnapshot: {},
    } as never);
    expect(result.deployment_id).toBe("dep-project-a");
    expect(result.deployment?.createdAt).toBe("2026-09-11T00:00:00.000Z");
    const [url, request] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://ship.example.test/api/deployments");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer credential");
    expect(new Headers(request.headers).get("x-organization-id")).toBe("org-a");
    expect(new Headers(request.headers).get("x-openship-scope")).toBe("fixed");
    expect(JSON.parse(request.body as string)).toEqual({ projectId: "project-a", forceAll: true });
    expect(request.redirect).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes credentials without mutating other clients", async () => {
    const fetcher = scopedFetch();
    let token = "old";
    const a = new OpenshipClient({
      baseUrl: "http://localhost:4000",
      token: () => token,
      organizationId: "org-a",
      fetch: fetcher,
    });
    const b = new OpenshipClient({
      baseUrl: "http://localhost:4000",
      token: "b",
      organizationId: "org-b",
      fetch: fetcher,
    });
    await a.deployments.create({ projectId: "project-a" });
    token = "new";
    await Promise.all([
      a.deployments.create({ projectId: "project-a" }),
      b.deployments.create({ projectId: "project-a" }),
    ]);
    const headers = fetcher.mock.calls
      .filter(([url]) => !url.endsWith("/health"))
      .map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers));
    expect(headers.map((h) => h.get("authorization")).sort()).toEqual([
      "Bearer b",
      "Bearer new",
      "Bearer old",
    ]);
    expect(headers.filter((h) => h.get("x-organization-id") === "org-a")).toHaveLength(2);
  });

  it("preserves structured API errors and never retries a mutation", async () => {
    const body = { error: "This access token is read-only", code: "TOKEN_READ_ONLY" };
    const fetcher = vi.fn(async () => Response.json(body, { status: 403 }));
    const client = new OpenshipClient({ baseUrl: "https://ship.example.test", fetch: fetcher });
    await expect(client.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "TOKEN_READ_ONLY",
      body,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects invalid inputs without sending a request and rejects invalid successful envelopes", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    const client = new OpenshipClient({ baseUrl: "http://localhost:4000", fetch: fetcher });
    await expect(
      client.deployments.create({ projectId: "project-a", refresh: "yes" } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.deployments.create({ projectId: "project-a" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("preserves ID-only compatibility without claiming a full deployment record", async () => {
    const data = { deployment_id: "dep-project-a", project_id: "project-a" };
    const fetcher = vi.fn(async () => Response.json({ data }, { status: 202 }));
    const client = new OpenshipClient({ baseUrl: "http://localhost:4000", fetch: fetcher });
    await expect(client.deployments.create({ projectId: "project-a" })).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an incomplete record in a successful response without retrying the submission", async () => {
    const body = {
      data: {
        deployment_id: "dep-project-a",
        project_id: "project-a",
        deployment: { id: "dep-project-a" },
      },
    };
    const fetcher = vi.fn(async () => Response.json(body, { status: 202 }));
    const client = new OpenshipClient({ baseUrl: "http://localhost:4000", fetch: fetcher });
    await expect(client.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      body,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refuses a scoped mutation before sending it to a server that ignores tenant confinement", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "ok" }));
    const client = new OpenshipClient({
      baseUrl: "https://old.example.test",
      organizationId: "org-a",
      fetch: fetcher,
    });
    await expect(client.deployments.create({ projectId: "project-a" })).rejects.toMatchObject({
      code: "SDK_SCOPE_UNSUPPORTED",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe("https://old.example.test/api/health");
  });
});

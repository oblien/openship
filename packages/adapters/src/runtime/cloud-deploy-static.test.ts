import { describe, expect, test, vi } from "vitest";
import { STACKS } from "@repo/core";
import { CloudRuntime } from "./cloud";
import { DEFAULT_RESOURCE_CONFIG } from "../types";
import type { DeployConfig } from "../types";

// #66 — a bare static site (root index.html, no framework) is detected as the
// "static" stack, whose outputDirectory is ".". The Pages deploy path used to
// hand Oblien `/app/.` (an unnormalized join), which the Pages API rejects with
// a "path not found" error — surfaced to the user as the misleading
// "Couldn't find the build output directory '.' after the build finished".
// The path exported to the edge must be a clean `/app`.
describe("CloudRuntime.deployStatic output path (regression #66)", () => {
  function fakeClientRecording(created: Array<{ path: string }>) {
    return {
      pages: {
        get: async () => null,
        create: async (input: { path: string; slug: string }) => {
          created.push(input);
          return { page: { slug: input.slug, url: null } };
        },
      },
      workspace: () => ({ delete: async () => {} }),
    };
  }

  const baseConfig: DeployConfig = {
    deploymentId: "dep_123456",
    projectId: "proj_profilcard",
    buildSessionId: "bs_1",
    imageRef: "ws_123",
    environment: "production",
    port: 3000,
    envVars: {},
    resources: DEFAULT_RESOURCE_CONFIG,
    publicEndpoints: [{ domain: "profilcard", domainType: "free" }],
  };

  test("static stack ('.') exports a clean /app, not /app/.", async () => {
    const created: Array<{ path: string }> = [];
    const rt = new CloudRuntime(fakeClientRecording(created) as never);

    const result = await rt.deployStatic({
      ...baseConfig,
      outputDirectory: STACKS.static.outputDirectory, // "."
    });

    expect(created).toHaveLength(1);
    expect(created[0].path).toBe("/app");
    expect(result.status).toBe("running");
  });

  test("a real subdirectory ('dist') is joined under /app", async () => {
    const created: Array<{ path: string }> = [];
    const rt = new CloudRuntime(fakeClientRecording(created) as never);

    await rt.deployStatic({ ...baseConfig, outputDirectory: "dist" });

    expect(created[0].path).toBe("/app/dist");
  });

  test("a ../ traversal that escapes /app is rejected", async () => {
    const created: Array<{ path: string }> = [];
    const rt = new CloudRuntime(fakeClientRecording(created) as never);

    await expect(
      rt.deployStatic({ ...baseConfig, outputDirectory: "../../etc" }),
    ).rejects.toThrow(/escapes/);
    expect(created).toHaveLength(0);
  });

  test("a provider 404 creates a new page, while a provider outage does not replace one", async () => {
    const created: Array<{ path: string }> = [];
    const client = fakeClientRecording(created);
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    client.pages.get = get;
    await new CloudRuntime(client as never).deployStatic({ ...baseConfig, outputDirectory: "dist" });
    expect(created).toHaveLength(1);
    get.mockRejectedValue(Object.assign(new Error("provider down"), { status: 503 }));
    await expect(new CloudRuntime(client as never).deployStatic({ ...baseConfig, outputDirectory: "dist" })).rejects.toThrow("provider down");
    expect(created).toHaveLength(1);
  });

  test("uses delegated page reads and reports a failed custom-domain connection", async () => {
    const connectDomain = vi.fn().mockRejectedValue(new Error("DNS verification failed"));
    const pageGet = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({ page: { slug: "profilcard", url: null } });
    const direct = vi.fn().mockRejectedValue(new Error("namespace token cannot read Pages"));
    const rt = new CloudRuntime({ pages: { get: direct } } as never, {
      namespace: "ns-a", adminProxy: { createPage: create, pages: { get: pageGet, create, connectDomain } as never },
    });
    await expect(rt.deployStatic({ ...baseConfig, outputDirectory: "dist", publicEndpoints: [{ domainType: "custom", customDomain: "app.example.com" }] }))
      .rejects.toThrow("DNS verification failed");
    expect(pageGet).toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });
});

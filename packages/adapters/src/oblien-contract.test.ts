import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE_URL, Oblien as OfficialOblien } from "oblien";
import { Oblien, cloudWorkspaceCreationFailure } from "./oblien";
import {
  cloudBillingContract,
  oblienApiBaseUrl,
  oblienApiUrl,
  toOblienVmOffer,
} from "./oblien-contract";

afterEach(() => vi.unstubAllGlobals());

it("inherits the published SDK default for the adapter and official client", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      return Response.json({ success: true, vms: [], namespaces: [] });
    }),
  );
  await new Oblien({ token: "fixture" }).vms.list();
  await new OfficialOblien({ token: "fixture" }).vms.list();
  expect(DEFAULT_API_BASE_URL).toBe("https://api.oblien.com/v1");
  expect(oblienApiBaseUrl().href).toBe(DEFAULT_API_BASE_URL);
  expect(urls).toEqual([`${DEFAULT_API_BASE_URL}/vms`, `${DEFAULT_API_BASE_URL}/vms`]);
});

it("keeps version and proxy mounts in real SDK JSON, Page, route and SSE requests without replaying a failed create", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url!, body: raw ? JSON.parse(raw) : {} });
    if (req.headers.authorization !== "Bearer fixture") {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/proxy/v1/vms/vm-a/stats/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"cpu":12}\n\n');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/proxy/v1/vms" && req.method === "POST") {
      res.writeHead(422).end(
        JSON.stringify({
          success: false,
          code: "CREATE_FAILED",
          details: { vm_id: "vm-failed" },
        }),
      );
      return;
    }
    if (req.url === "/proxy/v1/vms") {
      res.end(
        JSON.stringify({ success: true, vms: [{ id: "vm-a", namespace: "tenant-a" }], total: 1 }),
      );
      return;
    }
    if (req.url === "/proxy/v1/vms/vm-a") {
      res.end(JSON.stringify({ success: true, vm: { id: "vm-a", namespace: "tenant-a" } }));
      return;
    }
    if (req.url === "/proxy/v1/pages") {
      res.end(JSON.stringify({ success: true, page: { slug: "site", source_vm_id: "vm-a" } }));
      return;
    }
    if (req.url === "/proxy/v1/domain/routes/site.example") {
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ success: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  try {
    const client = new Oblien({
      token: "fixture",
      baseUrl: `http://127.0.0.1:${address.port}/proxy/v1`,
    });
    expect((await client.vms.list()).vms[0]?.id).toBe("vm-a");
    expect((await client.vm("vm-a").get()).namespace).toBe("tenant-a");
    await client.pages.create({ vm_id: "vm-a", name: "Site", slug: "site", path: "/dist" });
    await client.routes.set("site.example", {
      routes: [{ match: { path: "/" }, action: { kind: "proxy", vm: "vm-a", port: 3000 } }],
    });
    for await (const sample of client.streamWorkspaceMetrics("vm-a")) {
      expect(sample).toEqual({ cpu: 12 });
      break;
    }
    const failure = await client.vms.create({ wait_ready: false }).catch((error) => error);
    expect(cloudWorkspaceCreationFailure(failure)).toMatchObject({ workspaceId: "vm-failed" });
    expect(
      calls.filter((call) => call.path === "/proxy/v1/vms" && call.body.wait_ready === false),
    ).toHaveLength(1);
    expect(calls.every((call) => call.path.startsWith("/proxy/v1/"))).toBe(true);
    expect(calls.find((call) => call.path.endsWith("/pages"))?.body).toMatchObject({
      vm_id: "vm-a",
    });
    expect(JSON.stringify(calls)).not.toContain("workspace_id");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("preserves paid limits, zero and unlimited counts while leaving customer metadata opaque", () => {
  const metadata = {
    workspace: "customer-chosen",
    max_workspaces: "opaque",
    capacity: { vcpus: 8, memoryMb: 16, diskGb: 32, workspaces: 42 },
  };
  const saved = {
    unitAmount: 12000,
    resourceLimits: { max_workspaces: null, max_vcpus: 8 },
    capacity: { vcpus: 4, memoryMb: 16384, diskGb: 128, workspaces: 0 },
    policy: { overdraft: 0, onOverdraftAction: "stop_workspaces" as const },
    metadata,
  };
  const native = toOblienVmOffer(saved);
  expect(native).toEqual({
    unitAmount: 12000,
    resourceLimits: { max_vms: null, max_vcpus: 8 },
    capacity: { vcpus: 4, memoryMb: 16384, diskGb: 128, vms: 0 },
    policy: { overdraft: 0, onOverdraftAction: "stop_vms" },
    metadata,
  });
  expect(cloudBillingContract({ success: true, subscription: { offer: native } })).toEqual({
    success: true,
    subscription: { offer: saved },
  });
  expect(native.metadata).toBe(metadata);
  expect(saved.capacity.workspaces).toBe(0);
});

it("rejects request paths that escape a versioned mount", () => {
  const base = oblienApiBaseUrl("https://provider.example/proxy/v2");
  for (const path of ["../vms", "/../vms", "https://other.example/vms", "//other.example/vms"])
    expect(() => oblienApiUrl(base, path)).toThrow();
  expect(oblienApiUrl(base, "/vms").href).toBe("https://provider.example/proxy/v2/vms");
});

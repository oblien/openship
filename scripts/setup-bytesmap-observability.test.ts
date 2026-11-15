import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupBytesMapObservability } from "./setup-bytesmap-observability";

const originalFetch = globalThis.fetch;
const oldTokenFile = process.env.BYTESMAP_API_TOKEN_FILE;
const org = "operator-organization";
const datasetId = "3df4c77e-d825-427d-9b23-f281d65a4d03";
const secret = "synthetic-operator-token-not-an-ingestion-key";
let directory: string;
let dataset: any;
let requests: { method: string; path: string; body: any; headers: Headers }[];
let wrongOrganization: boolean;
let failSecondView: boolean;
let queryCount: number;
let viewCount: number;
let dashboardCount: number;
let output: ReturnType<typeof spyOn>;
const config = () => ({
  apiUrl: "https://account.example.test",
  organizationId: org,
  datasetId,
  manifestPath: join(directory, "install.json"),
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-bytesmap-setup-"));
  const tokenPath = join(directory, "operator.json");
  await writeFile(tokenPath, JSON.stringify({ token: secret }), { mode: 0o600 });
  process.env.BYTESMAP_API_TOKEN_FILE = tokenPath;
  requests = [];
  wrongOrganization = false;
  failSecondView = false;
  queryCount = viewCount = dashboardCount = 0;
  dataset = {
    id: datasetId,
    sourceId: "owned-source",
    tableName: "dataset_scoped",
    version: 1,
    projectId: "operations-project",
    dimensions: [],
  };
  output = spyOn(console, "log").mockImplementation(() => {});
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    requests.push({ method, path, body, headers });
    expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
    if (path === "/api/me")
      return Response.json({ organizationId: wrongOrganization ? "other-organization" : org });
    if (path === `/api/events/datasets/${datasetId}` && method === "GET")
      return Response.json({ data: dataset });
    expect(headers.get("x-bytesmap-project")).toBe("operations-project");
    if (method === "PATCH") {
      dataset = { ...dataset, ...body, version: 2 };
      return Response.json({ data: dataset });
    }
    if (path === "/api/queries") return Response.json({ query: { id: `query-${queryCount++}` } });
    if (path === "/api/views") {
      if (failSecondView && viewCount === 1) {
        failSecondView = false;
        return Response.json({}, { status: 503 });
      }
      return Response.json({ view: { id: `view-${viewCount++}` } });
    }
    if (path === "/api/dashboards") {
      dashboardCount++;
      return Response.json({ dashboard: { id: "dashboard" } });
    }
    if (path.endsWith("/runtime"))
      return Response.json({ workspace: { id: "workspace", version: 1 } });
    if (path.endsWith("/publish"))
      return Response.json({ workspace: { id: "workspace", publicationId: "published" } });
    throw new Error(`Unexpected test request: ${method} ${path}`);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  output.mockRestore();
  if (oldTokenFile === undefined) delete process.env.BYTESMAP_API_TOKEN_FILE;
  else process.env.BYTESMAP_API_TOKEN_FILE = oldTokenFile;
  await rm(directory, { recursive: true, force: true });
});

test("operator preview is read-only and mismatched authority cannot modify the dataset", async () => {
  await setupBytesMapObservability(config(), false);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  await expect(readFile(config().manifestPath)).rejects.toThrow();
  expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  requests.length = 0;
  wrongOrganization = true;
  await expect(setupBytesMapObservability(config(), true)).rejects.toThrow("organization");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe("GET");
});

test("setup resumes a partially saved installation and does not duplicate completed panels", async () => {
  failSecondView = true;
  await expect(setupBytesMapObservability(config(), true)).rejects.toThrow("503");
  expect(queryCount).toBe(2);
  expect(viewCount).toBe(1);
  await setupBytesMapObservability(config(), true);
  await setupBytesMapObservability(config(), true);
  expect(queryCount).toBe(4);
  expect(viewCount).toBe(4);
  expect(dashboardCount).toBe(1);
  const manifest = await readFile(config().manifestPath, "utf8");
  expect(JSON.parse(manifest).publicationId).toBe("published");
  expect(manifest).not.toContain(secret);
  expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  expect(dataset.dimensions.length).toBeLessThanOrEqual(64);
});

test("incompatible dataset types are rejected before any resource or manifest is written", async () => {
  dataset.dimensions = [{ name: "trace_id", type: "number" }];
  await expect(setupBytesMapObservability(config(), true)).rejects.toThrow("Incompatible");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  await expect(readFile(config().manifestPath)).rejects.toThrow();
});

import { describe, expect, it, vi } from "vitest";
import type { ProjectControlOperations } from "@repo/contracts";
import { OpenshipClient } from "../src/client";
import { projectFixture } from "../../contracts/test/fixtures";

const connection = { id: "link/a", sourceProjectId: "database", sourceName: "Database", sourceAppTemplateId: "postgres", sourceServiceId: "svc-db", sourceServiceName: "Postgres", targetProjectId: "project/a", outputId: "url", envKey: "DATABASE_URL", mode: "internal" };
const binding = { provider: "custom", bucket: "uploads", endpoint: "https://s3.example.test", region: "auto", envKeys: ["S3_BUCKET"], boundAt: "2026-09-12T00:00:00.000Z" };
const providers = { custom: { id: "custom", label: "S3-compatible", endpointPlaceholder: "https://s3.example.test", defaultRegion: "auto", forcePathStyle: true } };
const cases: Array<{ name: keyof ProjectControlOperations; method: string; path: string; input?: unknown; pathInput?: boolean; output: unknown; envelope?: boolean }> = [
  { name: "listConnectionCandidates", method: "GET", path: "/connections/candidates", output: [{ id: "database", name: "Database", description: "production", appTemplateId: null }], envelope: true },
  { name: "listConnections", method: "GET", path: "/connections", output: [connection], envelope: true },
  { name: "listConnectionConsumers", method: "GET", path: "/connections/consumers", output: [{ id: "link/a", targetProjectId: "consumer", targetName: "Consumer", targetSlug: "consumer", outputId: "url", envKey: "DATABASE_URL", mode: "internal" }], envelope: true },
  { name: "createConnection", method: "POST", path: "/connections", input: { sourceProjectId: "database", outputId: "url", envKey: "DATABASE_URL" }, output: { connection, requiresRedeploy: true }, envelope: true },
  { name: "connectBundle", method: "POST", path: "/connections/bundle", input: { sourceProjectId: "database", items: [{ outputId: "url", envKey: "DATABASE_URL" }] }, output: { connections: [connection], requiresRedeploy: true }, envelope: true },
  { name: "removeConnection", method: "DELETE", path: "/connections/link%2Fa", input: "link/a", pathInput: true, output: { requiresRedeploy: true }, envelope: true },
  { name: "getStorage", method: "GET", path: "/storage", output: { binding: null, volumes: null, resolvedVolumes: [], envPreset: "generic", envKeys: [], candidates: [], providers }, envelope: true },
  { name: "bindStorage", method: "POST", path: "/storage", input: { bucket: "uploads", provider: "custom", endpoint: "https://s3.example.test", accessKeyId: "key", secretAccessKey: "secret" }, output: { binding, requiresRedeploy: true }, envelope: true },
  { name: "unbindStorage", method: "DELETE", path: "/storage", output: { removed: true }, envelope: true },
  { name: "getEdgeConfig", method: "GET", path: "/edge-config", output: { reachable: false, saved: {}, hosts: [] } },
];

describe("remote project integrations", () => {
  it.each(cases)("preserves transport and validated results for $name", async test => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://ship.test/api/projects/project%2Fa" + test.path);
      expect(init?.method).toBe(test.method);
      if (test.input !== undefined && !test.pathInput) expect(JSON.parse(init!.body as string)).toEqual(test.input);
      else expect(init?.body).toBeUndefined();
      return Response.json(test.envelope ? { data: test.output } : test.output);
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const operation = client.projects[test.name] as (id: string, input?: unknown) => Promise<unknown>;
    expect(await operation("project/a", test.input)).toEqual(test.output);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("validates local operations and uses the existing import/scan/list routes", async () => {
    const project = projectFixture("local", "Imported");
    const scan = { success: true, path: "/srv/source", name: "Imported", stack: "static", projectType: "app", packageManager: "", installCommand: "", buildCommand: "", startCommand: "", buildImage: "", outputDirectory: ".", rootDirectory: "./" };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      switch (String(url)) {
        case "https://ship.test/api/projects/import":
          expect(JSON.parse(init!.body as string)).toEqual({ name: "Imported", localPath: "/srv/source" });
          return Response.json({ data: project });
        case "https://ship.test/api/projects/scan":
          expect(JSON.parse(init!.body as string)).toEqual({ path: "/srv/source" });
          return Response.json(scan);
        case "https://ship.test/api/projects/local": return Response.json({ success: true, projects: [project] });
        default: throw new Error("Unexpected request");
      }
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(client.projects.importLocal({ name: "Invalid", localPath: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.projects.scanLocal({ path: "/srv/source" })).toEqual(scan);
    expect(await client.projects.importLocal({ name: "Imported", localPath: "/srv/source" })).toEqual(project);
    expect(await client.projects.listLocal()).toEqual({ success: true, projects: [project] });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { OpenshipClient } from "../src/client";

const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "openship-sdk-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function server() {
  let archive: Buffer | undefined;
  const commands: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/source-upload") {
      expect(new Headers(init?.headers).get("authorization")).toBe("upload-credential");
      archive = Buffer.from(await new Response(init?.body).arrayBuffer());
      return new Response(null, { status: 204 });
    }
    commands.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    if (path === "/api/projects/folder/session") return Response.json({
      sessionId: "session/opaque", expiresAt: Date.now() + 60_000,
      upload: { url: "https://storage.test/source-upload", absoluteUrl: "https://storage.test/source-upload", method: "POST", headers: { Authorization: "upload-credential" }, requiresAuth: false, withCredentials: false },
    });
    if (path === "/api/projects/folder/scan/session%2Fopaque") return Response.json({
      success: true, name: "detected", stack: "node", startCommand: "node index.js", port: 3000,
      projectType: "services", packageManager: "npm", installCommand: "", buildCommand: "", buildImage: "node:22", outputDirectory: "", rootDirectory: "",
      services: [{ name: "web", image: "node:22", ports: [], dependsOn: [], environment: {}, volumes: [] }],
      configDiagnostics: { warnings: ["An optional setting was ignored"], errors: [] },
    });
    if (path === "/api/projects/ensure") return Response.json({ success: true, project_id: "project-a", created: false });
    if (path === "/api/deployments/build/access") return Response.json({ success: true, deployment_id: "dep-a", project_id: "project-a" });
    throw new Error("Unexpected endpoint " + path);
  });
  return {
    client: new OpenshipClient({ baseUrl: "https://ship.test", token: "api-credential", fetch: fetcher }),
    fetcher, commands, tar: () => gunzipSync(archive!).toString(),
  };
}

describe("SDK source deployments", () => {
  it("removes generated source and its archive as soon as upload succeeds", async () => {
    const root = await directory();
    vi.stubEnv("TMPDIR", root);
    const s = server();
    const result = await s.client.sources.stage({ source: { type: "files", files: { "index.html": "uploaded-content" } } });
    expect(result).toMatchObject({ sessionId: "session/opaque" });
    expect(s.tar()).toContain("uploaded-content");
    expect(s.commands.map(command => command.path)).toEqual(["/api/projects/folder/session"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses TMPDIR as a source before creating a remote upload session", async () => {
    const root = await directory();
    vi.stubEnv("TMPDIR", root);
    await writeFile(join(root, "openship-upload-old.tar.gz"), "old artifact");
    const s = server();
    await expect(s.client.sources.stage({ source: { type: "directory", path: root } })).rejects.toThrow(/temporary directory/);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["openship-upload-old.tar.gz"]);
  });

  it.each(["session", "upload"])("cleans generated source and archives when the %s request fails", async failure => {
    const root = await directory();
    vi.stubEnv("TMPDIR", root);
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (failure === "upload" && url.endsWith("/projects/folder/session")) return Response.json({
        sessionId: "session", expiresAt: Date.now() + 60_000,
        upload: { url: "/upload", absoluteUrl: "https://ship.test/upload", method: "POST", headers: {}, requiresAuth: true, withCredentials: false },
      });
      if (url.endsWith("/upload")) await new Response(init?.body).arrayBuffer();
      return Response.json({ error: "storage unavailable" }, { status: 503 });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(client.sources.stage({ source: { type: "files", files: { "dist/index.html": "built site" } } })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("requests editable values through the existing scan while retaining masked scans by default", async () => {
    const s = server();
    await s.client.sources.scan("session/opaque");
    await s.client.sources.scan("session/opaque", { includeEnv: true });
    expect(s.commands).toEqual([
      { path: "/api/projects/folder/scan/session%2Fopaque", body: {} },
      { path: "/api/projects/folder/scan/session%2Fopaque", body: { includeEnv: true } },
    ]);
  });

  it("shares the full generated-code workflow, snapshots bytes, and preserves service selection", async () => {
    const s = server();
    const bytes = new TextEncoder().encode("initial-content");
    const services = ["web"];
    const result = s.client.deploy({
      source: { type: "files", files: { "index.js": bytes, "dist/index.html": "published-site" } },
      name: "app", projectId: "existing", environment: "preview", serverId: "server-a", serviceIds: services,
    });
    bytes.fill(65);
    services.push("another-service");
    await expect(result).resolves.toMatchObject({
      deployment_id: "dep-a", project_id: "project-a",
      configDiagnostics: { warnings: ["An optional setting was ignored"] },
    });
    expect(s.tar()).toContain("initial-content");
    expect(s.tar()).toContain("published-site");
    expect(s.commands[2]?.body).toMatchObject({
      projectId: "existing", serverId: "server-a", name: "detected", deploymentEnvironment: "preview",
    });
    expect(s.commands[3]?.body).toMatchObject({
      projectId: "project-a", uploadSessionId: "session/opaque", deployTarget: "server", serverId: "server-a",
      serviceIds: ["web"], environment: "preview", services: [{ name: "web", image: "node:22", ports: [], dependsOn: [], environment: {}, volumes: [] }],
    });
  });

  it("includes existing build outputs while excluding dependencies and git metadata", async () => {
    const dir = await directory();
    for (const part of ["dist", "node_modules", ".git"]) await mkdir(join(dir, part));
    await writeFile(join(dir, "dist/index.html"), "static-site-marker");
    await writeFile(join(dir, "node_modules/private.js"), "dependency-marker");
    await writeFile(join(dir, ".git/config"), "git-credential-marker");
    const s = server();
    await s.client.deploy({ source: { type: "directory", path: dir } });
    expect(s.tar()).toContain("static-site-marker");
    expect(s.tar()).not.toContain("dependency-marker");
    expect(s.tar()).not.toContain("git-credential-marker");
  });

  it.each(["../escape", "/absolute", "C:/absolute", "a/../b", "a\\b", "a//b"])(
    "rejects generated path %s before creating a server session", async (path) => {
      const s = server();
      await expect(s.client.deploy({ source: { type: "files", files: { [path]: "data" } } }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(s.fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects symlinks escaping the selected source before opening a server session", async () => {
    const [dir, outside] = await Promise.all([directory(), directory()]);
    await writeFile(join(outside, "secret"), "private-data");
    await symlink(join(outside, "secret"), join(dir, "escape"));
    const s = server();
    await expect(s.client.deploy({ source: { type: "directory", path: dir } }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("honors cancellation before opening an upload session", async () => {
    const s = server();
    await expect(s.client.deploy({ source: { type: "files", files: { "index.html": "ok" } }, signal: AbortSignal.abort(new Error("stopped")) }))
      .rejects.toThrow("stopped");
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("refuses incomplete upload responses without inventing an expiry or uploading bytes", async () => {
    const fetcher = vi.fn(async () => Response.json({ sessionId: "broken", upload: { url: "https://storage.test/upload" } }));
    const ship = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(ship.sources.stage({ source: { type: "files", files: { "index.html": "ok" } } })).rejects.toThrow("Invalid upload session response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete scan results and malformed service definitions", async () => {
    const fetcher = vi.fn(async () => Response.json({ name: "app", stack: "node" }));
    const ship = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(ship.sources.scan("session")).rejects.toThrow("Invalid source scan response");
    fetcher.mockImplementation(async () => Response.json({
      name: "app", stack: "node", projectType: "services", packageManager: "npm", installCommand: "",
      buildCommand: "", startCommand: "", buildImage: "node:22", outputDirectory: "", rootDirectory: "",
      services: [{ name: "web", ports: "3000" }],
    }));
    await expect(ship.sources.scan("session")).rejects.toThrow("Invalid source scan response");
  });
});

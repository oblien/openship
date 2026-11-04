import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

let directory: string;
let app: Hono;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-static-path-security-"));
  await mkdir(join(directory, "static/admin"), { recursive: true });
  await writeFile(join(directory, "static/admin/secret.txt"), "private content");
  await writeFile(join(directory, "static/hello world.txt"), "public content");
  app = new Hono();
  app.use("/static/admin/*", (c) => c.text("Unauthorized", 401));
  app.use("/static/*", serveStatic({ root: directory }));
});

afterAll(() => rm(directory, { recursive: true, force: true }));

describe("static-file authorization", () => {
  it("does not decode a malformed path into a directory whose middleware never ran", async () => {
    // GHSA-rmxm-3fg6-px4f: the router leaves this malformed escape encoded,
    // while the vulnerable static adapter decodes it again to /static/admin.
    const response = await app.request("http://localhost/static/%%36%31dmin/secret.txt");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private content");
  });

  it.each(["admin", "%61dmin"])("keeps authorization on the %s path", async (path) => {
    const response = await app.request(`http://localhost/static/${path}/secret.txt`);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  it("continues serving public files with ordinary URL encoding", async () => {
    const response = await app.request("http://localhost/static/hello%20world.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public content");
  });
});

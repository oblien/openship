import { createServer } from "node:http";
import Dockerode from "dockerode";
import { describe, expect, it } from "vitest";
import { swarmRequest } from "./api";

describe("Swarm control transport", () => {
  it("keeps the CAS version in the URL and secret values only in the JSON body", async () => {
    let request: { url?: string; body: string; auth?: string };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      request = {
        url: req.url,
        body: Buffer.concat(chunks).toString(),
        auth: req.headers["x-registry-auth"] as string,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const docker = new Dockerode({
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
      });
      const spec = {
        Name: "release",
        TaskTemplate: {
          ContainerSpec: { Env: ["PASSWORD=private value &?"], Image: "private/image" },
        },
        Mode: { Replicated: { Replicas: 0 } },
      };
      await swarmRequest(docker, "POST", "/services/id/update", {
        body: spec,
        query: { version: 42 },
        headers: { "X-Registry-Auth": "credential" },
      });
      expect(request!.url).toBe("/services/id/update?version=42");
      expect(JSON.parse(request!.body)).toEqual(spec);
      expect(request!.auth).toBe("credential");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
  it("rejects stale Docker versions instead of retrying over a concurrent writer", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "update out of sequence" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const docker = new Dockerode({
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
      });
      await expect(
        swarmRequest(docker, "POST", "/services/id/update", { body: {}, query: { version: 1 } }),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

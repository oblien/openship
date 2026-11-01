import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  managedNodeListenerSource,
  managedNodeEnvironment,
  managedNodeDockerLines,
  MANAGED_NODE_LABEL,
  MANAGED_NODE_PORTS,
} from "./node-listener";
import type { BuildConfig } from "../../types";
const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

describe("managed Node runtime listener", () => {
  it.each(["positional", "options", "ipv6"])(
    "adapts the declared public %s listener without changing a private listener",
    async (form) => {
      const directory = await mkdtemp(join(tmpdir(), "openship-listener-"));
      directories.push(directory);
      const file = join(directory, "listener.cjs");
      await writeFile(file, managedNodeListenerSource);
      const port = await freePort();
      const listen =
        form === "positional"
          ? `server.listen(${port}, '127.0.0.1', ready)`
          : `server.listen({port:${port},host:${JSON.stringify(form === "ipv6" ? "::1" : "localhost")}},ready)`;
      const script = `const http=require('node:http');const server=http.createServer((req,res)=>res.end('ok'));const privateServer=http.createServer();
      privateServer.listen(0,'127.0.0.1',()=>{${listen}});
      async function ready(){const response=await fetch('http://127.0.0.1:${port}');console.log(JSON.stringify({public:server.address().address,private:privateServer.address().address,body:await response.text()}));server.closeAllConnections();server.close();privateServer.close();}`;
      const result = await run("node", ["--require", file, "-e", script], {
        timeout: 15000,
        env: { ...process.env, [MANAGED_NODE_PORTS]: String(port) },
      });
      expect(JSON.parse(result.stdout)).toEqual({
        public: "0.0.0.0",
        private: "127.0.0.1",
        body: "ok",
      });
    },
  );
  it("does not adapt an image used without Cloud activation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-listener-"));
    directories.push(directory);
    const file = join(directory, "listener.cjs");
    await writeFile(file, managedNodeListenerSource);
    const result = await run(
      "node",
      [
        "--require",
        file,
        "-e",
        "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().address);s.close()})",
      ],
      { timeout: 10000, env: { ...process.env, [MANAGED_NODE_PORTS]: "" } },
    );
    expect(result.stdout.trim()).toBe("127.0.0.1");
  });
  it("activates only labelled images and replaces untrusted port lists with declared endpoints", () => {
    const env = { NODE_OPTIONS: "--max-old-space-size=256", [MANAGED_NODE_PORTS]: "9229" };
    expect(managedNodeEnvironment({}, env, [3000])).toBe(env);
    expect(managedNodeEnvironment({ [MANAGED_NODE_LABEL]: "1" }, env, [3000, 3000, 4000])).toEqual({
      ...env,
      [MANAGED_NODE_PORTS]: "3000,4000",
    });
    expect(managedNodeEnvironment({ [MANAGED_NODE_LABEL]: "1" }, env, [])).toEqual({
      ...env,
      [MANAGED_NODE_PORTS]: "",
    });
  });
  it("includes the adapter only in generated Cloud Node runtime recipes", () => {
    const config = {
      managedNodeListener: true,
      runtimeImage: "node:24",
      hasServer: true,
      packageManager: "npm",
    } as BuildConfig;
    expect(managedNodeDockerLines(config).join("\n")).toContain("ENTRYPOINT");
    for (const override of [
      { managedNodeListener: false },
      { isStatic: true },
      { hasServer: false },
      { packageManager: "bun" },
      { runtimeImage: "python:3.12" },
      { runtimeImage: "registry.example/node:24" },
    ])
      expect(managedNodeDockerLines({ ...config, ...override })).toEqual([]);
  });
});

import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import { expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

function fixture(failures: Error[], authenticated = true) {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  const auth = { username: "user", password: "secret", serveraddress: "ghcr.io" };
  const pull = vi.fn(async () => new PassThrough());
  Object.assign(runtime, {
    connectionOptions: { resolveRegistryAuth: async () => authenticated ? auth : undefined },
    _docker: { pull, modem: { followProgress: (_stream: unknown, done: (error?: Error) => void) => done(failures.shift()) } },
  });
  return { runtime, pull, auth };
}

it("recovers a daemon API pull when saved credentials reject a public image", async () => {
  const { runtime, pull, auth } = fixture([new Error("denied")]);
  await runtime.pullImage("ghcr.io/public/worker:1", { force: true });
  expect(pull.mock.calls).toEqual([["ghcr.io/public/worker:1", { authconfig: auth }], ["ghcr.io/public/worker:1", {}]]);
});

it("keeps private images inaccessible and reports the authenticated failure", async () => {
  const { runtime, pull } = fixture([new Error("unauthorized: login expired"), new Error("denied")]);
  await expect(runtime.pullImage("ghcr.io/private/api:1", { force: true })).rejects.toMatchObject({
    code: "REGISTRY_ACCESS_DENIED",
    details: { registry: "ghcr.io", imageRef: "ghcr.io/private/api:1" },
    message: expect.stringContaining("login expired"),
  });
  expect(pull).toHaveBeenCalledTimes(2);
});

it("does not repeat an already anonymous denial or retry unrelated errors", async () => {
  for (const [failures, authenticated] of [[new Error("denied"), false], [new Error("no space left on device"), true]] as const) {
    const { runtime, pull } = fixture([failures], authenticated);
    await expect(runtime.pullImage("ghcr.io/o/img:1", { force: true })).rejects.toThrow(failures.message);
    expect(pull).toHaveBeenCalledTimes(1);
  }
});

it.each([false, true])("closes a cancelled daemon pull (streaming: %s)", async (streaming) => {
  const requested = vi.fn();
  const closed = vi.fn();
  const server = createServer((req, res) => {
    requested(req.method, req.url);
    res.once("close", closed);
    if (streaming) res.write('{"status":"Downloading"}\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    const docker = new Dockerode({ host: "127.0.0.1", port: address.port });
    const started = vi.spyOn(docker.modem, "followProgress");
    const { runtime } = fixture([]);
    Object.assign(runtime, { _docker: docker });
    const controller = new AbortController();
    let failure: unknown;
    const pull = runtime
      .pullImage("ghcr.io/private/api:1", { force: true, signal: controller.signal })
      .catch((error) => {
        failure = error;
      });

    await expect.poll(() => requested.mock.calls.length).toBe(1);
    if (streaming) await expect.poll(() => started.mock.calls.length).toBe(1);
    controller.abort();
    await expect.poll(() => closed.mock.calls.length).toBe(1);
    await pull;
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(requested).toHaveBeenCalledOnce();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

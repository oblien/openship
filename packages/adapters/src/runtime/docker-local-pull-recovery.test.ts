import { PassThrough } from "node:stream";
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
  await expect(runtime.pullImage("ghcr.io/private/api:1", { force: true })).rejects.toThrow("login expired");
  expect(pull).toHaveBeenCalledTimes(2);
});

it("does not repeat an already anonymous denial or retry unrelated errors", async () => {
  for (const [failures, authenticated] of [[new Error("denied"), false], [new Error("no space left on device"), true]] as const) {
    const { runtime, pull } = fixture([failures], authenticated);
    await expect(runtime.pullImage("ghcr.io/o/img:1", { force: true })).rejects.toThrow(failures.message);
    expect(pull).toHaveBeenCalledTimes(1);
  }
});

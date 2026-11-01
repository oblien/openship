import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

const digest = `sha256:${"a".repeat(64)}`;
function fixture(options: { digest?: string; error?: Error; wait?: boolean } = {}) {
  const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
  const stream = new PassThrough();
  const auth = {
    username: "registry-user",
    password: "registry-password",
    serveraddress: "ghcr.io",
  };
  const push = vi.fn(async () => stream);
  const tagImage = vi.fn(async () => {});
  Object.assign(runtime, {
    tagImage,
    connectionOptions: { resolveRegistryAuth: vi.fn(async () => auth) },
    resolveImageDigest: vi.fn(async () => options.digest),
    _docker: {
      getImage: () => ({ push }),
      modem: {
        followProgress: (
          _stream: PassThrough,
          done: (error?: Error) => void,
          progress: (value: unknown) => void,
        ) => {
          stream.on("error", done);
          if (options.wait) return;
          if (options.error) {
            done(options.error);
            return;
          }
          if (options.digest === undefined) progress({ aux: { Digest: digest } });
          done();
        },
      },
    },
  });
  return { runtime, stream, push, tagImage, auth };
}

describe("cluster image publication", () => {
  it("uses existing registry credentials and returns the digest confirmed by the registry", async () => {
    const { runtime, push, tagImage, auth, stream } = fixture();
    expect(await runtime.publishImage("local:build", "ghcr.io/team/api:release-1")).toBe(
      `ghcr.io/team/api@${digest}`,
    );
    expect(tagImage).toHaveBeenCalledWith("local:build", "ghcr.io/team/api:release-1");
    expect(push).toHaveBeenCalledWith({ authconfig: auth, abortSignal: expect.any(AbortSignal) });
    expect(stream.destroyed).toBe(true);
  });
  it.each(["ghcr.io/other/app@" + digest, "ghcr.io/team/api@sha256:short"])(
    "refuses an unconfirmed digest %s",
    async (resolved) => {
      await expect(
        fixture({ digest: resolved }).runtime.publishImage(
          "local:build",
          "ghcr.io/team/api:release-1",
        ),
      ).rejects.toThrow("did not confirm");
    },
  );
  it("propagates registry failure without treating an uploaded tag as a release", async () => {
    await expect(
      fixture({ error: new Error("registry denied push") }).runtime.publishImage(
        "local:build",
        "ghcr.io/team/api:release-1",
      ),
    ).rejects.toThrow("denied push");
  });
  it("cancellation closes an ongoing push", async () => {
    const { runtime, stream } = fixture({ wait: true });
    const controller = new AbortController();
    const work = runtime.publishImage(
      "local:build",
      "ghcr.io/team/api:release-1",
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(work).rejects.toThrow("cancelled");
    expect(stream.destroyed).toBe(true);
  });

  it.each([false, true])(
    "uses the bounded remote command path and removes its credentials (failed: %s)",
    async (failed) => {
      const { runtime, push, auth } = fixture();
      const executor = {
        exec: vi.fn(async (command: string) => {
          if (command.includes("docker push")) {
            if (failed) throw new Error("remote registry denied push");
            return `release-1: digest: ${digest} size: 1234`;
          }
          return "";
        }),
        writeFile: vi.fn(async (_path: string, _content: string) => {}),
        runWithAbortSignal: vi.fn(async (_signal: AbortSignal, run: () => Promise<string>) =>
          run(),
        ),
      };
      Object.assign(runtime, {
        connectionOptions: { executor, resolveRegistryAuth: async () => auth },
      });
      const publication = runtime.publishImage("local:build", "ghcr.io/team/api:release-1");
      if (failed) await expect(publication).rejects.toThrow("remote registry denied push");
      else await expect(publication).resolves.toBe(`ghcr.io/team/api@${digest}`);
      expect(push).not.toHaveBeenCalled();
      const commands = executor.exec.mock.calls.map(([command]) => command).join("\n");
      expect(commands).not.toContain(auth.password);
      expect(commands).not.toContain(
        Buffer.from(`${auth.username}:${auth.password}`).toString("base64"),
      );
      expect(commands).toContain("mkdir -m 700 '/tmp/openship-push-");
      expect(commands).toContain("chmod 600 '/tmp/openship-push-");
      expect(executor.writeFile).toHaveBeenCalledOnce();
      expect(executor.exec).toHaveBeenLastCalledWith(
        expect.stringMatching(/^rm -rf '\/tmp\/openship-push-/),
        { timeout: 10_000 },
      );
      expect(executor.runWithAbortSignal).toHaveBeenCalledTimes(2);
    },
  );
});

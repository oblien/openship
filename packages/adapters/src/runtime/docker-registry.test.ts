import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

describe("DockerRuntime registry publication", () => {
  it("returns a digest-pinned reference and removes only the temporary registry tag", async () => {
    const tag = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue({});
    const remove = vi.fn().mockResolvedValue(undefined);
    const image = {
      tag,
      push,
      remove,
      inspect: vi.fn().mockResolvedValue({
        RepoDigests: ["registry.example.com/team/blog/web@sha256:0123456789abcdef"],
      }),
    };
    const docker = {
      getImage: vi.fn().mockReturnValue(image),
      modem: { followProgress: (_stream: unknown, done: (error: Error | null) => void) => done(null) },
    };
    const runtime = Object.create(DockerRuntime.prototype) as DockerRuntime;
    Object.defineProperties(runtime, {
      _docker: { value: docker },
      transport: { value: { kind: "socket", description: "test socket" } },
    });

    await expect(runtime.publishImage({
      source: "openship-build:web",
      target: "registry.example.com/team/blog/web:dep_123",
      auth: { serverAddress: "registry.example.com", username: "robot", password: "write-only-secret" },
    })).resolves.toEqual({
      pushedTag: "registry.example.com/team/blog/web:dep_123",
      digestRef: "registry.example.com/team/blog/web@sha256:0123456789abcdef",
    });

    expect(tag).toHaveBeenCalledWith({ repo: "registry.example.com/team/blog/web", tag: "dep_123" });
    expect(push).toHaveBeenCalledWith({
      authconfig: { serveraddress: "registry.example.com", username: "robot", password: "write-only-secret" },
    });
    expect(remove).toHaveBeenCalledWith({ force: true });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { duplexPair, PassThrough, Readable } from "node:stream";
import type Dockerode from "dockerode";
import { buildDockerImage } from "./docker-buildkit-session";

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./docker-exec-stream", () => ({
  daemonConnectionFrom: () => ({}),
  startBuildKitSessionStream: transport.open,
}));
const sockets: ReturnType<typeof duplexPair>[] = [];
function socket() {
  const pair = duplexPair();
  sockets.push(pair);
  return pair[0];
}
afterEach(() => {
  for (const pair of sockets.splice(0)) for (const stream of pair) stream.destroy();
  vi.clearAllMocks();
});

describe("BuildKit session lifecycle", () => {
  it.each(["end", "error", "close"])(
    "releases the reverse session when the build emits %s",
    async (event) => {
      const connection = socket();
      transport.open.mockResolvedValueOnce(connection);
      const response = new PassThrough();
      const docker = {
        modem: { dial: vi.fn((_options, callback) => callback(null, response)) },
      } as unknown as Dockerode;
      await buildDockerImage(docker, Readable.from([]), { version: "2" });
      if (event === "error") response.emit("error", new Error("disconnected"));
      else response.emit(event);
      expect(connection.destroyed).toBe(true);
      response.destroy();
    },
  );

  it("closes the session if the build request fails before returning a stream", async () => {
    const connection = socket();
    transport.open.mockResolvedValueOnce(connection);
    const docker = {
      modem: { dial: vi.fn((_options, callback) => callback(new Error("build refused"))) },
    } as unknown as Dockerode;
    await expect(buildDockerImage(docker, Readable.from([]), { version: "2" })).rejects.toThrow(
      "build refused",
    );
    expect(connection.destroyed).toBe(true);
  });

  it("closes a late upgrade after cancellation without submitting a build", async () => {
    const connection = socket();
    let resolve!: (value: typeof connection) => void;
    transport.open.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const controller = new AbortController();
    const dial = vi.fn();
    const running = buildDockerImage(
      { modem: { dial } } as unknown as Dockerode,
      Readable.from([]),
      {
        version: "2",
        abortSignal: controller.signal,
      },
    );
    const rejected = expect(running).rejects.toThrow();
    controller.abort();
    resolve(connection);
    await rejected;
    expect(connection.destroyed).toBe(true);
    expect(dial).not.toHaveBeenCalled();
  });

  it("cancels the response as well as the session", async () => {
    const connection = socket();
    transport.open.mockResolvedValueOnce(connection);
    const response = new PassThrough();
    const controller = new AbortController();
    const docker = {
      modem: { dial: vi.fn((_options, callback) => callback(null, response)) },
    } as unknown as Dockerode;
    await buildDockerImage(docker, Readable.from([]), {
      version: "2",
      abortSignal: controller.signal,
    });
    controller.abort();
    expect(response.destroyed).toBe(true);
    expect(connection.destroyed).toBe(true);
  });
});

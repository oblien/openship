import { beforeEach, describe, expect, it, vi } from "vitest";

const writeSSE = vi.hoisted(() => vi.fn());
const onAbort = vi.hoisted(() => vi.fn());
let sseHandler:
  | ((sseStream: { writeSSE: typeof writeSSE; onAbort: (cb: () => void) => void }) => Promise<void>)
  | null = null;

vi.mock("../../lib/sse", () => ({
  streamSSE: vi.fn((_c: unknown, handler: typeof sseHandler) => {
    sseHandler = handler;
    return new Response();
  }),
}));

vi.mock("../../lib/ssh-manager", () => ({
  sshManager: { retain: vi.fn(), release: vi.fn() },
}));

vi.mock("../../lib/request-context", () => ({
  getRequestContext: vi.fn(() => ({ userId: "u1", organizationId: "o1" })),
}));

const streamServiceRuntimeLogs = vi.hoisted(() => vi.fn());
vi.mock("./service.service", () => ({
  streamServiceRuntimeLogs,
}));

import { runtimeLogStream } from "./service.controller";

function fakeC() {
  return {
    req: {
      param: (name: string) => ({ id: "proj_1", serviceId: "svc_1" })[name as "id" | "serviceId"],
      query: (_name: string) => undefined,
    },
  } as any;
}

type SseStream = Parameters<NonNullable<typeof sseHandler>>[0];

function mustSettle<T>(p: Promise<T>, ms = 250): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("handler did not settle")), ms),
    ),
  ]);
}

async function startStream(
  opts: {
    stream?: { cleanup: ReturnType<typeof vi.fn>; serverId: string | null };
    impl?: (...args: unknown[]) => Promise<unknown>;
  } = {},
) {
  const stream = opts.stream ?? { cleanup: vi.fn(), serverId: null };
  if (opts.impl) streamServiceRuntimeLogs.mockImplementation(opts.impl as any);
  else streamServiceRuntimeLogs.mockResolvedValue(stream);
  await runtimeLogStream(fakeC());
  const running = sseHandler!({
    writeSSE,
    onAbort,
  } as SseStream);
  await Promise.resolve();
  expect(streamServiceRuntimeLogs).toHaveBeenCalledTimes(1);
  const lastCall = streamServiceRuntimeLogs.mock.calls.at(-1)!;
  return {
    running,
    onEnd: lastCall[4]?.onEnd as (() => void) | undefined,
    stream,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sseHandler = null;
  writeSSE.mockResolvedValue(undefined);
});

describe("runtime log stream natural end", () => {
  it("writes the end event before releasing the response", async () => {
    let releaseFlush!: () => void;
    const flush = new Promise<void>((r) => (releaseFlush = r));
    writeSSE.mockImplementation((frame: { event: string }) =>
      frame.event === "end" ? flush : Promise.resolve(),
    );

    const { running, onEnd, stream } = await startStream();
    onEnd!();

    expect(await Promise.race([running.then(() => "settled"), Promise.resolve("pending")])).toBe(
      "pending",
    );
    expect(stream.cleanup).not.toHaveBeenCalled();
    expect(writeSSE).toHaveBeenCalledWith(expect.objectContaining({ event: "end" }));

    releaseFlush();
    await mustSettle(running);
    expect(stream.cleanup).toHaveBeenCalledTimes(1);
  });

  it("settles and cleans up when the container ends during subscription", async () => {
    const cleanup = vi.fn();
    const { running } = await startStream({
      impl: async (...args: unknown[]) => {
        (args[4] as { onEnd: () => void }).onEnd();
        return { cleanup, serverId: null };
      },
    });
    await mustSettle(running);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("still releases via client abort and runs cleanup exactly once", async () => {
    const cleanup = vi.fn();
    const { running } = await startStream({ stream: { cleanup, serverId: null } });
    const abortCb = onAbort.mock.calls.at(-1)![0] as () => void;

    abortCb();
    abortCb();
    await mustSettle(running);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("emits one terminal frame when the runtime reports end more than once", async () => {
    let releaseFlush!: () => void;
    writeSSE.mockImplementation(() => new Promise<void>((resolve) => (releaseFlush = resolve)));
    const { running, onEnd } = await startStream();

    onEnd!();
    onEnd!();
    expect(writeSSE).toHaveBeenCalledTimes(1);

    releaseFlush();
    await mustSettle(running);
  });
});

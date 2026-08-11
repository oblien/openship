import "./_setup-env";
import type { Context } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(async () => undefined),
  sshWithExecutor: vi.fn(),
  upsertMailServer: vi.fn(),
  streamSSE: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    mailServer: {
      upsert: mocks.upsertMailServer,
    },
  },
  tryAcquireAdvisoryLock: mocks.acquireLock,
}));

vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn(async () => undefined) },
}));

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-1" }),
}));

vi.mock("../../../src/lib/controller-helpers", () => ({
  isServerInOrg: vi.fn(async () => true),
}));

vi.mock("../../../src/lib/sse", () => ({
  streamSSE: mocks.streamSSE,
}));

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: { withExecutor: mocks.sshWithExecutor },
}));

import { startSetup } from "../../../src/modules/mail/mail.controller";

function setupContext() {
  return {
    req: {
      json: vi.fn(async () => ({
        serverId: "server-1",
        domain: "example.com",
      })),
    },
    json: vi.fn((body: unknown, status?: number) => ({ body, status })),
  } as unknown as Context;
}

describe("startSetup concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue({ release: mocks.releaseLock });
    mocks.sshWithExecutor.mockRejectedValue(new Error("ssh unavailable"));
    mocks.upsertMailServer.mockResolvedValue({});
    mocks.streamSSE.mockReturnValue({ stream: true });
  });

  test("releases failed reservations and allows only one concurrent setup", async () => {
    mocks.acquireLock.mockRejectedValueOnce(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startSetup(setupContext())).resolves.toEqual({
      body: { error: "Could not reserve mail setup. Please try again." },
      status: 503,
    });
    errorSpy.mockRestore();
    vi.clearAllMocks();

    let releaseLookup!: () => void;
    const lookupPending = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    mocks.acquireLock.mockImplementation(async () => {
      await lookupPending;
      return { release: mocks.releaseLock };
    });

    const first = startSetup(setupContext());
    await vi.waitFor(() => expect(mocks.acquireLock).toHaveBeenCalledTimes(1));

    const second = startSetup(setupContext());
    await Promise.resolve();
    releaseLookup();

    const responses = await Promise.all([first, second]);

    expect(mocks.streamSSE).toHaveBeenCalledTimes(1);
    expect(responses).toContainEqual({
      body: { error: "Setup already running" },
      status: 409,
    });

    expect(mocks.releaseLock).not.toHaveBeenCalled();
    const setupCallback = mocks.streamSSE.mock.calls[0]?.[1];
    await setupCallback({ writeSSE: vi.fn(async () => undefined) });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDriver: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("./client", () => ({
  getDriver: mocks.getDriver,
  getPgPool: () => ({ connect: mocks.connect }),
  PG_POOL_MAX: 2,
}));

import { tryAcquireAdvisoryLock, withAdvisoryLock } from "./advisory-lock";

describe("tryAcquireAdvisoryLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDriver.mockReturnValue("postgres");
  });

  test("returns null and releases the connection when the lock is busy", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ acquired: false }] })),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    await expect(tryAcquireAdvisoryLock("mail-setup:server-1")).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledWith("SELECT pg_try_advisory_lock($1) AS acquired", [
      expect.any(Number),
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("holds the connection until the acquired lock is released", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    const lock = await tryAcquireAdvisoryLock("mail-setup:server-2");
    expect(lock).not.toBeNull();
    expect(client.release).not.toHaveBeenCalled();

    await lock?.release();
    await lock?.release();

    expect(client.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock($1)", [
      expect.any(Number),
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("uses a no-op handle for the single-process PGlite driver", async () => {
    mocks.getDriver.mockReturnValue("pglite");

    const lock = await tryAcquireAdvisoryLock("mail-setup:server-3");
    await lock?.release();

    expect(lock).not.toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test("destroys the pooled connection when unlocking fails", async () => {
    const unlockError = new Error("connection lost");
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce(unlockError),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    const lock = await tryAcquireAdvisoryLock("mail-setup:server-4");

    await expect(lock?.release()).rejects.toThrow("connection lost");
    expect(client.release).toHaveBeenCalledWith(unlockError);
  });

  test("returns null immediately when the lock-client permit is occupied", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    const held = await tryAcquireAdvisoryLock("held");
    await expect(tryAcquireAdvisoryLock("skipped")).resolves.toBeNull();
    expect(mocks.connect).toHaveBeenCalledOnce();
    await held?.release();
  });
});

describe("withAdvisoryLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDriver.mockReturnValue("postgres");
  });

  test("reserves pool capacity instead of admitting every long-lived lock client", async () => {
    const clients = [0, 1].map(() => ({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }),
      release: vi.fn(),
    }));
    mocks.connect.mockImplementation(async () => clients[mocks.connect.mock.calls.length - 1]);
    let finishFirst!: () => void;
    const first = withAdvisoryLock(
      "project-runtime:first",
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());

    const second = withAdvisoryLock("project-runtime:second", async () => {});
    await Promise.resolve();
    expect(mocks.connect).toHaveBeenCalledOnce();

    finishFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  test("destroys a connection whose unlock failed and releases the permit", async () => {
    const unlockError = new Error("unlock connection lost");
    const brokenClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(unlockError),
      release: vi.fn(),
    };
    const nextClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(brokenClient).mockResolvedValueOnce(nextClient);

    await expect(withAdvisoryLock("first", async () => {})).rejects.toThrow(unlockError);
    expect(brokenClient.release).toHaveBeenCalledWith(unlockError);
    await expect(withAdvisoryLock("second", async () => "ok")).resolves.toBe("ok");
  });
});

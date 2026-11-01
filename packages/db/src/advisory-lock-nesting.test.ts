import type { Pool } from "pg";
import { expect, test, vi } from "vitest";
import { createAdvisoryLocks, hashStringToInt } from "./advisory-lock-factory";

function fixture(poolMax = 2) {
  const newClient = () => ({
    query: vi.fn(async () => ({ rows: [{ pg_advisory_unlock: true }] })),
    release: vi.fn(),
  });
  const clients: ReturnType<typeof newClient>[] = [];
  const connect = vi.fn(async () => {
    const client = newClient();
    clients.push(client);
    return client;
  });
  const locks = createAdvisoryLocks({
    getDriver: () => "pg", getPgPool: () => ({ connect }) as unknown as Pool, poolMax,
  });
  return { locks, clients, connect };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("checks billing inside a quota lock with the minimum supported pool", async () => {
  const { locks, clients, connect } = fixture();
  await expect(locks.withAdvisoryLock("cloud:service-quota:org-a", () =>
    locks.withAdvisoryLock("billing:entitlement:org-a", async () => "verified"),
  )).resolves.toBe("verified");
  expect(connect).toHaveBeenCalledOnce();
  expect(clients[0]!.release).toHaveBeenCalledOnce();
  expect(clients[0]!.query.mock.calls).toEqual([
    ["SELECT pg_advisory_lock($1)", [hashStringToInt("cloud:service-quota:org-a")]],
    ["SELECT pg_advisory_lock($1)", [hashStringToInt("billing:entitlement:org-a")]],
    ["SELECT pg_advisory_unlock($1)", [hashStringToInt("billing:entitlement:org-a")]],
    ["SELECT pg_advisory_unlock($1)", [hashStringToInt("cloud:service-quota:org-a")]],
  ]);
}, 2000);

test("finishes a burst of nested quota checks when every lock permit is occupied", async () => {
  const { locks, clients, connect } = fixture(3);
  const admitted = deferred();
  let active = 0;
  const results = await Promise.all(["org-a", "org-b"].map(org =>
    locks.withAdvisoryLock(`cloud:service-quota:${org}`, async () => {
      if (++active === 2) admitted.resolve();
      await admitted.promise;
      return locks.withAdvisoryLock(`billing:entitlement:${org}`, async () => org);
    }),
  ));
  expect(results).toEqual(["org-a", "org-b"]);
  expect(connect).toHaveBeenCalledTimes(2);
  for (const client of clients) expect(client.release).toHaveBeenCalledOnce();
}, 2000);

test("serializes parallel siblings requesting the same key on one connection", async () => {
  const { locks, clients } = fixture();
  const started = deferred(), finish = deferred();
  let secondEntered = false;
  const operation = locks.withAdvisoryLock("quota", async () => {
    const first = locks.withAdvisoryLock("entitlement", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const second = locks.withAdvisoryLock("entitlement", async () => { secondEntered = true; });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    finish.resolve();
    await Promise.all([first, second]);
  });
  await operation;
  expect(secondEntered).toBe(true);
  expect(clients[0]!.query).toHaveBeenCalledTimes(6);
});

test("can re-enter an ancestor key without releasing the ancestor's lock", async () => {
  const { locks, clients } = fixture();
  await locks.withAdvisoryLock("entitlement", async () => {
    await locks.withAdvisoryLock("entitlement", async () => "same owner");
    expect(clients[0]!.query).toHaveBeenCalledTimes(1);
    expect(clients[0]!.release).not.toHaveBeenCalled();
  });
  expect(clients[0]!.query).toHaveBeenCalledTimes(2);
});

test("keeps locks and the connection until running children finish after a parent failure", async () => {
  const { locks, clients } = fixture();
  const started = deferred(), finish = deferred();
  const failure = new Error("other branch failed");
  const operation = locks.withAdvisoryLock("quota", async () => {
    void locks.withAdvisoryLock("entitlement", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    throw failure;
  });
  const rejected = expect(operation).rejects.toThrow(failure);
  await started.promise;
  await Promise.resolve();
  expect(clients[0]!.release).not.toHaveBeenCalled();
  expect(clients[0]!.query).toHaveBeenCalledTimes(2);
  finish.resolve();
  await rejected;
  expect(clients[0]!.query).toHaveBeenCalledTimes(4);
  expect(clients[0]!.release).toHaveBeenCalledOnce();
});

test("unlocks both scopes after a child callback fails and admits the next operation", async () => {
  const { locks, clients, connect } = fixture();
  await expect(locks.withAdvisoryLock("quota", () => locks.withAdvisoryLock("entitlement", async () => {
    throw new Error("provider unavailable");
  }))).rejects.toThrow("provider unavailable");
  expect(clients[0]!.query).toHaveBeenCalledTimes(4);
  expect(clients[0]!.release).toHaveBeenCalledWith(undefined);
  await expect(locks.withAdvisoryLock("next", async () => "retry")).resolves.toBe("retry");
  expect(connect).toHaveBeenCalledTimes(2);
});

test("destroys a session with a failed child unlock even if the callback catches it", async () => {
  const { locks, clients, connect } = fixture();
  const failure = new Error("child unlock failed");
  await expect(locks.withAdvisoryLock("quota", async () => {
    clients[0]!.query.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    clients[0]!.query.mockRejectedValueOnce(failure);
    await expect(locks.withAdvisoryLock("entitlement", async () => {})).rejects.toThrow(failure);
    return "must not report success";
  })).rejects.toThrow(failure);
  expect(clients[0]!.release).toHaveBeenCalledWith(failure);
  await locks.withAdvisoryLock("next", async () => {});
  expect(connect).toHaveBeenCalledTimes(2);
});

test("does not reuse a released connection through an inherited asynchronous context", async () => {
  const { locks, clients, connect } = fixture();
  const later = deferred();
  let detached!: Promise<string>;
  await locks.withAdvisoryLock("quota", async () => {
    detached = (async () => {
      await later.promise;
      return locks.withAdvisoryLock("entitlement", async () => "later request");
    })();
  });
  expect(clients[0]!.release).toHaveBeenCalledOnce();
  later.resolve();
  await expect(detached).resolves.toBe("later request");
  expect(connect).toHaveBeenCalledTimes(2);
  expect(clients[1]!.release).toHaveBeenCalledOnce();
});

test("keeps independent database factories on their own connections", async () => {
  const first = fixture(), second = fixture();
  await first.locks.withAdvisoryLock("quota", () => second.locks.withAdvisoryLock("entitlement", async () => {}));
  expect(first.connect).toHaveBeenCalledOnce();
  expect(second.connect).toHaveBeenCalledOnce();
});

test("detached workers do not retain admission locks or deadlock the minimum pool", async () => {
  const { locks, clients, connect } = fixture();
  const releaseWorker = deferred();
  const enteredWorker = deferred();
  let worker!: Promise<void>;
  await locks.withAdvisoryLock("admission", async () => {
    worker = locks.runOutsideAdvisoryLock(() => locks.withAdvisoryLock("execution", async () => {
      enteredWorker.resolve();
      await releaseWorker.promise;
    }));
  });
  await enteredWorker.promise;
  expect(connect).toHaveBeenCalledTimes(2);
  expect(clients[0]!.release).toHaveBeenCalledOnce();
  expect(clients[1]!.release).not.toHaveBeenCalled();
  releaseWorker.resolve();
  await worker;
  expect(clients[1]!.release).toHaveBeenCalledOnce();
});

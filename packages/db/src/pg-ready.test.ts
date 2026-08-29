import { afterEach, describe, expect, test, vi } from "vitest";
import type { Pool } from "pg";
import { awaitPgReady } from "./client";

// Boot must survive a Postgres that isn't answering YET, and must not survive one that
// will never answer.
//
// The regression: `createPgClient` connected once and ran migrate() immediately, so a
// postgres that was seconds late (host reboot, a postgres restart, crash recovery —
// none of which go through compose's `depends_on: service_healthy`) exited the process.
// Docker's `restart: unless-stopped` then re-ran the same one-shot boot, which is what
// an operator sees as a crash loop, on a log line that blames DNS.

/** A pool whose connect() fails with `errs` in order, then succeeds forever. */
function poolThatFails(...errs: unknown[]): { pool: Pool; connect: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  let call = 0;
  const connect = vi.fn(async () => {
    const err = errs[call++];
    if (err) throw err;
    return { release };
  });
  return { pool: { connect } as unknown as Pool, connect };
}

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("awaitPgReady", () => {
  test("returns as soon as a connection is handed out", async () => {
    const { pool, connect } = poolThatFails();
    await awaitPgReady(pool, { budgetMs: 1_000, retryMs: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("releases the probe connection back to the pool", async () => {
    const release = vi.fn();
    const pool = { connect: async () => ({ release }) } as unknown as Pool;
    await awaitPgReady(pool, { budgetMs: 1_000, retryMs: 1 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("retries a late postgres instead of throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Bun reports an unresolvable compose alias exactly like this — the shape that
    // used to kill boot outright.
    const dnsMiss = Object.assign(new Error("getaddrinfo ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "getaddrinfo",
      name: "DNSException",
    });
    const { pool, connect } = poolThatFails(dnsMiss, dnsMiss, pgError("57P03"));
    await awaitPgReady(pool, { budgetMs: 5_000, retryMs: 1 });
    expect(connect).toHaveBeenCalledTimes(4);
  });

  test("retries an unclassified error rather than assuming it is permanent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { pool, connect } = poolThatFails(new Error("timeout exceeded when trying to connect"));
    await awaitPgReady(pool, { budgetMs: 5_000, retryMs: 1 });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // The other half: waiting must not paper over a config error an operator has to fix.
  // 28P01 is the #488 signal — `.env` no longer matches the surviving data volume — and
  // burying it behind a 90s wait is how that diagnosis got lost the first time.
  for (const code of ["28P01", "28000", "3D000"]) {
    test(`fails immediately on ${code} without retrying`, async () => {
      const { pool, connect } = poolThatFails(pgError(code), pgError(code));
      await expect(awaitPgReady(pool, { budgetMs: 60_000, retryMs: 1 })).rejects.toThrow(
        `pg error ${code}`,
      );
      expect(connect).toHaveBeenCalledTimes(1);
    });
  }

  // A NaN budget makes every deadline comparison false, so the loop would never reach
  // its exit — boot would hang instead of failing. Falls back to the real default.
  test("an unusable budget cannot turn the wait into a hang", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { pool } = poolThatFails(refused, refused);
    await awaitPgReady(pool, { budgetMs: Number.NaN, retryMs: 1 });
  });

  test("gives up at the budget and rethrows the driver's own error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:5432"), {
      code: "ECONNREFUSED",
    });
    // Never succeeds: every entry is a failure and the list is longer than the budget
    // allows attempts for.
    const { pool, connect } = poolThatFails(...Array.from({ length: 500 }, () => refused));
    await expect(awaitPgReady(pool, { budgetMs: 30, retryMs: 10 })).rejects.toThrow(
      "connect ECONNREFUSED 10.0.0.2:5432",
    );
    expect(connect.mock.calls.length).toBeGreaterThan(0);
    expect(connect.mock.calls.length).toBeLessThan(10);
  });
});

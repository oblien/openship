import "./_setup-env";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mail topology probe is memoized per executor, and that executor is POOLED
 * per server (ssh-manager, 5-min idle). The invariant pinned here is the one whose
 * violation refused a fresh install: a `flavor: "none"` must NEVER be retained, so
 * a `getStatus` poll probing a box before its container is up cannot pin "no mail
 * engine" for the rest of the setup run — the DKIM step (`requireMailEngine`) has
 * to see the engine `deploy_engine` just created. A POSITIVE result stays memoized
 * (the dedup the memo exists for), and `forgetMailEngine` drops it at a mutation.
 */

vi.mock("@repo/adapters", () => ({
  // Carried so ssh-manager (imported transitively) and mail-engine both load; the
  // values are irrelevant to these tests, only `detectMailEngine` is exercised.
  HOST_STATE_DIR: "/root/.openship",
  detectMailEngine: vi.fn(),
  MAIL_CONTAINER: "openship-mail",
  MAIL_DB_CONTAINER: "openship-mail-db",
  MAIL_DB_NAME: "vmail",
  MAIL_HOST_PATHS: {
    saslPasswd: "/opt/openship/mail/postfix/sasl_passwd",
    senderRelayhost: "/opt/openship/mail/postfix/sender_relayhost",
    amavisUserConf: "/opt/openship/mail/amavis/50-user",
  },
}));

import { detectMailEngine } from "@repo/adapters";
import {
  forgetMailEngine,
  requireMailEngine,
  resolveMailEngine,
} from "../../../src/modules/mail/mail-engine";

const CONTAINER = {
  flavor: "container" as const,
  running: true,
  exists: true,
  image: "ghcr.io/oblien/openship-mail:0.6.1",
};
const NONE = { flavor: "none" as const, running: false, exists: false, image: null };

/** Fresh executor identity per test so the per-executor memo can't leak across them. */
let exec: { exec: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  exec = { exec: vi.fn() };
  forgetMailEngine(exec as never);
});

describe("resolveMailEngine — memo", () => {
  it("dedups a POSITIVE result: one probe shared across concurrent + repeat callers", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);

    const [a, b] = await Promise.all([
      resolveMailEngine(exec as never),
      resolveMailEngine(exec as never),
    ]);
    const c = await resolveMailEngine(exec as never);

    expect(a).toEqual(CONTAINER);
    expect(b).toEqual(CONTAINER);
    expect(c).toEqual(CONTAINER);
    expect(detectMailEngine).toHaveBeenCalledTimes(1);
  });

  it("does NOT retain a 'none': the next call re-probes and sees the engine once it is up", async () => {
    // A status poll probes the box mid-setup, before the container exists.
    vi.mocked(detectMailEngine).mockResolvedValueOnce(NONE);
    expect(await resolveMailEngine(exec as never)).toEqual(NONE);

    // deploy_engine brings the container up. The next probe must NOT return the
    // cached "none" — it re-detects and finds the running engine.
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    expect(await resolveMailEngine(exec as never)).toEqual(CONTAINER);
    expect(detectMailEngine).toHaveBeenCalledTimes(2);
  });

  it("does not remember a transient failure as 'no engine'", async () => {
    vi.mocked(detectMailEngine).mockRejectedValueOnce(new Error("ssh channel closed"));
    await expect(resolveMailEngine(exec as never)).rejects.toThrow("ssh channel closed");

    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    expect(await resolveMailEngine(exec as never)).toEqual(CONTAINER);
  });

  it("forgetMailEngine drops a cached POSITIVE so a mutation boundary re-detects", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    await resolveMailEngine(exec as never);
    await resolveMailEngine(exec as never);
    expect(detectMailEngine).toHaveBeenCalledTimes(1); // memoized

    forgetMailEngine(exec as never); // topology changed under us
    await resolveMailEngine(exec as never);
    expect(detectMailEngine).toHaveBeenCalledTimes(2); // re-probed
  });
});

describe("requireMailEngine — the DKIM step's gate", () => {
  it("refuses on a 'none' box, then SUCCEEDS on the next call once the engine exists — no manual forget", async () => {
    // This is the exact reported failure: a poll cached "none", then the deploy
    // step created the engine. Because "none" isn't retained, the very next
    // requireMailEngine (step 6) sees the real engine instead of refusing.
    vi.mocked(detectMailEngine).mockResolvedValueOnce(NONE);
    await expect(requireMailEngine(exec as never)).rejects.toMatchObject({
      code: "MAIL_ENGINE_NOT_INSTALLED",
    });

    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const probe = await requireMailEngine(exec as never);
    expect(probe).toEqual(CONTAINER);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { connOk, connFail } from "@repo/core";

// The real built-in checks drag in the ssh manager and the db; the preflight only
// cares that it routes through the registry, so stub the side-effect import and
// register the `ssh-server` kind ourselves (later registrations win).
vi.mock("../../lib/connectivity-checks", () => ({}));

import { registerConnectivityCheck } from "../../lib/connectivity";
import { preflightMailSetup } from "./mail-setup-preflight";

/**
 * #492: `POST /mail/setup` IS the SSE stream, so a host executor that answers
 * every command with `Permission denied` still produced a 200 and an empty form.
 * This preflight is the only place that can turn that into a non-2xx, so it has
 * to (a) fail when the channel doesn't work and (b) keep the host's own reason.
 */
describe("preflightMailSetup", () => {
  beforeEach(() => {
    registerConnectivityCheck("ssh-server", async () => connOk(12));
  });

  it("allows setup to start when the SSH channel works", async () => {
    expect(await preflightMailSetup("srv_1")).toBeNull();
  });

  it("blocks setup and keeps the host's own reason", async () => {
    registerConnectivityCheck("ssh-server", async () =>
      connFail("permission_denied", "Permission denied (publickey,password)"),
    );

    const failure = await preflightMailSetup("srv_1");
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe("permission_denied");
    // The reporter's failure was visible only in the api logs — the operator must
    // read the actual SSH error, not a generic "setup failed".
    expect(failure!.error).toContain("Permission denied (publickey,password)");
    expect(failure!.error).toContain("nothing was attempted");
  });

  it("blocks setup when the server is unreachable", async () => {
    registerConnectivityCheck("ssh-server", async () =>
      connFail("unreachable", "No route to host"),
    );

    const failure = await preflightMailSetup("srv_1");
    expect(failure?.code).toBe("unreachable");
    expect(failure?.error).toContain("No route to host");
  });

  it("blocks setup when the check itself throws", async () => {
    registerConnectivityCheck("ssh-server", async () => {
      throw new Error("All configured authentication methods failed");
    });

    const failure = await preflightMailSetup("srv_1");
    expect(failure).not.toBeNull();
    expect(failure!.error).toContain("authentication methods failed");
  });

  it("passes the serverId through to the check", async () => {
    const seen: unknown[] = [];
    registerConnectivityCheck("ssh-server", async (input) => {
      seen.push(input);
      return connOk(12);
    });

    await preflightMailSetup("srv_abc");
    expect(seen).toEqual(["srv_abc"]);
  });
});

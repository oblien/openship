import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { tokenCommand } from "../../src/commands/token";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

/**
 * A FRESH command per run.
 *
 * `tokenCommand` is a module-level commander instance and commander keeps parsed
 * option values ON that instance, so a flag set by one test is still set for the
 * next one. Any test asserting a flag's DEFAULT is therefore order-dependent —
 * which is exactly what the two guard tests below do. Re-importing the module
 * gives each run its own Command tree. (`vi.mock` factories survive
 * `resetModules`, so the config stub above still applies.)
 */
async function freshTokenCommand(): Promise<typeof tokenCommand> {
  vi.resetModules();
  return (await import("../../src/commands/token")).tokenCommand;
}

describe("openship token list", () => {
  it("GETs /tokens and tabulates the data envelope", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: [{ id: "t1", name: "ci", readOnly: false }] },
    }));
    const { out, code } = await runCommand(tokenCommand, ["list"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/tokens");
    expect(out).toContain("t1");
    expect(out).toContain("ci");
  });
});

describe("openship token create", () => {
  it("POSTs the name + flags and prints the one-time secret", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: { id: "t2", name: "deploy", token: "opsh_secret_xyz" } },
    }));
    const { out, err, code } = await runCommand(await freshTokenCommand(), [
      "create",
      "deploy",
      "--read-only",
      "--full-access",
    ]);
    expect(code).toBe(0);
    const req = fetchStub.calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://api.test/api/tokens");
    expect((req.body as Record<string, unknown>).name).toBe("deploy");
    expect((req.body as Record<string, unknown>).readOnly).toBe(true);
    // Intent is sent explicitly — the API refuses to infer it from an empty list.
    expect((req.body as Record<string, unknown>).fullAccess).toBe(true);
    expect(out + err).toContain("opsh_secret_xyz");
  });

  it("sends grants (not fullAccess) when the token is scoped", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: { id: "t3", name: "bot", token: "opsh_secret_scoped" } },
    }));
    const { code } = await runCommand(await freshTokenCommand(), [
      "create",
      "bot",
      "--grant",
      "project:abc123:read,write",
    ]);
    expect(code).toBe(0);
    const body = fetchStub.calls[0].body as Record<string, unknown>;
    expect(body.fullAccess).toBeUndefined();
    expect(body.grants).toEqual([
      { resourceType: "project", resourceId: "abc123", permissions: ["read", "write"] },
    ]);
  });

  /**
   * The whole point of the API change: an unscoped token must be ASKED for. The
   * CLI refuses locally so the message can name the flags, and — importantly —
   * without ever reaching the network.
   */
  it("refuses to mint an unscoped token when neither --grant nor --full-access is given", async () => {
    fetchStub = stubFetch(() => ({ json: { data: {} } }));
    const { err, code } = await runCommand(await freshTokenCommand(), ["create", "oops"]);
    expect(code).toBe(1);
    expect(err).toContain("--full-access");
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("rejects --grant together with --full-access as ambiguous", async () => {
    fetchStub = stubFetch(() => ({ json: { data: {} } }));
    const { err, code } = await runCommand(await freshTokenCommand(), [
      "create",
      "oops",
      "--grant",
      "project:abc123:read",
      "--full-access",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe("openship token revoke", () => {
  it("DELETEs the token by id", async () => {
    fetchStub = stubFetch(() => ({ status: 204 }));
    const { err, code } = await runCommand(tokenCommand, ["revoke", "t9"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("DELETE");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/tokens/t9");
    expect(err).toContain("revoked");
  });
});

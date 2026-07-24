import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { tokenCommand } from "../../src/commands/token";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

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
    const { out, err, code } = await runCommand(tokenCommand, ["create", "deploy", "--read-only"]);
    expect(code).toBe(0);
    const req = fetchStub.calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://api.test/api/tokens");
    expect((req.body as Record<string, unknown>).name).toBe("deploy");
    expect((req.body as Record<string, unknown>).readOnly).toBe(true);
    expect(out + err).toContain("opsh_secret_xyz");
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

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "https://controller.example.test",
  getToken: () => "opsh_pat_fixture",
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: true }),
  requireSelfHost: () => {},
}));
import { mailCommand } from "../../src/commands/mail";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openship-mail-cli-"));
  setJsonMode(true);
});
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
  rmSync(directory, { recursive: true, force: true });
});

describe("mail CLI workflows", () => {
  it("does not reset setup state merely because JSON output is enabled", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
    const result = await runCommand(mailCommand, ["reset", "srv_mail"]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    expect((await runCommand(mailCommand, ["reset", "srv_mail", "--yes"])).code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it.each([
    ['event: log\ndata: {"message":"Installing"}\n\n', 1],
    ['event: complete\ndata: {"success":false}\n\n', 1],
    ['event: complete\ndata: {"success":true,"domain":"example.com"}\n\n', 0],
    ['event: dns_pending\ndata: {"resumeStep":12,"records":{}}\n\n', 0],
    ['event: ptr_pending\ndata: {"resumeStep":13,"target":"mail.example.com"}\n\n', 0],
    ['event: port_conflict\ndata: {"portConflicts":[]}\n\n', 1],
  ])(
    "reports setup outcome accurately and never duplicates the install (%s)",
    async (text, code) => {
      fetchStub = stubFetch(() => ({ headers: { "content-type": "text/event-stream" }, text }));
      const result = await runCommand(mailCommand, [
        "setup",
        "srv_mail",
        "--domain",
        "example.com",
      ]);
      expect(result.code, result.err).toBe(code);
      expect(fetchStub.calls).toHaveLength(1);
      expect(
        result.out
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toHaveLength(1);
    },
  );

  it("shows mailbox input schema offline without requiring a mail server", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Schema discovery must not make requests");
    });
    const result = await runCommand(mailCommand, ["mailbox", "create", "srv_mail", "--schema"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).required).toContain("password");
    expect(fetchStub.calls).toEqual([]);
  });

  it("requires explicit permanent deletion and otherwise retains mailbox data", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true, mode: "soft" } }));
    expect(
      (await runCommand(mailCommand, ["mailbox", "remove", "srv_mail", "alice@example.com"])).code,
    ).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    expect(
      (
        await runCommand(mailCommand, [
          "mailbox",
          "remove",
          "srv_mail",
          "alice@example.com",
          "--yes",
        ])
      ).code,
    ).toBe(0);
    expect(new URL(fetchStub.calls[0].url).searchParams.get("hard")).toBe("false");
  });

  it("takes postmaster secrets from files without echoing them", async () => {
    const secret = "fixture-postmaster-password";
    const file = join(directory, "password");
    writeFileSync(file, secret, { mode: 0o600 });
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
    const result = await runCommand(mailCommand, [
      "postmaster",
      "set-password",
      "srv_mail",
      "--password-file",
      file,
    ]);
    expect(result.code, result.err).toBe(0);
    expect(fetchStub.calls[0].body).toEqual({ serverId: "srv_mail", password: secret });
    expect(result.out + result.err).not.toContain(secret);
  });

  it("reports individual restart failures instead of treating HTTP 200 as success", async () => {
    fetchStub = stubFetch(() => ({
      json: { results: [{ key: "postfix", unit: "postfix", ok: false, error: "Not running" }] },
    }));
    expect((await runCommand(mailCommand, ["restart-all", "srv_mail", "--yes"])).code).toBe(1);
    expect(fetchStub.calls).toHaveLength(1);
  });
});

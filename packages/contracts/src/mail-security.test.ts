import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MailRequestSchemas } from "./mail-inputs";

describe("Fail2ban public inputs", () => {
  it.each(["203.0.113.10", "2001:db8::1", "::ffff:192.0.2.128"])(
    "accepts an address and explicit jail: %s",
    (ip) => {
      expect(Value.Check(MailRequestSchemas.fail2banBan, { ip, jail: "postfix-sasl" })).toBe(true);
      expect(Value.Check(MailRequestSchemas.fail2banUnban, { ip })).toBe(true);
    },
  );
  it.each([
    "--all",
    "127.1",
    "999.1.2.3",
    "example.com",
    "192.0.2.0/24",
    "fe80::1%eth0",
    "1.2.3.4\n",
    "$(id)",
  ])("rejects options and non-addresses in both actions: %j", (ip) => {
    for (const schema of [MailRequestSchemas.fail2banBan, MailRequestSchemas.fail2banUnban]) {
      expect(Value.Check(schema, { ip, jail: "postfix" })).toBe(false);
    }
  });
  it.each(["--all", "", "postfix;id", "postfix\n", "a".repeat(65)])(
    "rejects unsafe jail %j",
    (jail) => {
      expect(Value.Check(MailRequestSchemas.fail2banStatus, { jail })).toBe(false);
      expect(Value.Check(MailRequestSchemas.fail2banBan, { ip: "203.0.113.10", jail })).toBe(false);
    },
  );
  it("requires an explicit jail only for bans and rejects extra options", () => {
    expect(Value.Check(MailRequestSchemas.fail2banBan, { ip: "203.0.113.10" })).toBe(false);
    expect(Value.Check(MailRequestSchemas.fail2banStatus, {})).toBe(true);
    expect(Value.Check(MailRequestSchemas.fail2banUnban, { ip: "203.0.113.10", all: true })).toBe(
      false,
    );
  });
});

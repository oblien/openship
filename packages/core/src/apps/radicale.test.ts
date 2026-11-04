import { describe, expect, it } from "vitest";
import { getAppTemplate } from "../app-templates";
import { validateSetting } from "../app-settings";

describe("Radicale mailbox setup", () => {
  const app = getAppTemplate("radicale")!;

  it("collects a hostname through the shared install and settings form", () => {
    const field = app
      .settings!.flatMap((group) => group.fields)
      .find((f) => f.key === "IMAP_HOST")!;
    expect(field).toMatchObject({
      service: "radicale",
      required: true,
      installStep: true,
      requiresRedeploy: true,
    });
    for (const host of [
      "mail.example.com",
      "mail.example.co.uk",
      "imap",
      "xn--mail-9za.example.com",
    ])
      expect(validateSetting(field, host)).toBeNull();
    for (const host of [
      "https://mail.example.com",
      "mail.example.com:143",
      "mail.example.com/path",
      "mail.example.com\n",
      "-mail.example.com",
      "mail..example.com",
      "a".repeat(64) + ".example.com",
      "$(touch /tmp/injected)",
    ])
      expect(validateSetting(field, host)).not.toBeNull();
  });
});

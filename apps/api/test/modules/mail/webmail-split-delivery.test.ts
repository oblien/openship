import "./_setup-env";
import { describe, expect, it } from "vitest";

import {
  managedMailWebmailSettings,
  WEBMAIL_SETTING_KEYS,
} from "@repo/platform/engine/modules/mail/webmail/webmail-install.service";

function values(settings: ReturnType<typeof managedMailWebmailSettings>) {
  return new Map(settings.map((setting) => [setting.key, setting.value]));
}

describe("managed webmail split delivery (GH-391)", () => {
  it("submits to local Postfix rather than bypassing it for the outbound relay", () => {
    const settings = values(
      managedMailWebmailSettings("webmail", "example.com", "webmail.example.com", false),
    );

    expect(settings.get(WEBMAIL_SETTING_KEYS.imapHost)).toBe("mail.example.com");
    expect(settings.get(WEBMAIL_SETTING_KEYS.imapPort)).toBe("993");
    expect(settings.get(WEBMAIL_SETTING_KEYS.smtpHost)).toBe("mail.example.com");
    expect(settings.get(WEBMAIL_SETTING_KEYS.smtpPort)).toBe("465");
    expect([...settings.values()].join(" ")).not.toMatch(/amazonaws|sendgrid|brevo/i);
  });

  it("pins only the browser origin for the proxy variant; the mail backend stays local", () => {
    const settings = values(
      managedMailWebmailSettings("webmail", "example.com", "mail.example.com", true),
    );

    expect(settings.get(WEBMAIL_SETTING_KEYS.trustedOrigins)).toBe("https://mail.example.com");
    expect(settings.get(WEBMAIL_SETTING_KEYS.smtpHost)).toBe("mail.example.com");
    expect(settings.get(WEBMAIL_SETTING_KEYS.smtpPort)).toBe("465");
  });
});

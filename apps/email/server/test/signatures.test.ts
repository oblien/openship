import { describe, expect, it } from "bun:test";
import { userSettingsSchema } from "../src/lib/schemas";
import { sanitizeSignatureHtml } from "../src/lib/signature";

describe("signature settings", () => {
  it("keeps existing accounts opted out and accepts partial signature updates", () => {
    expect(userSettingsSchema.parse({}).signatureEnabled).toBe(false);
    expect(userSettingsSchema.partial().parse({ signatureEnabled: true }).signatureEnabled).toBe(
      true,
    );
  });

  it("preserves formatting, safe links, and remote logos", () => {
    const html =
      '<p><strong>Alex</strong><br /><a href="mailto:alex@example.com">Email</a><img src="https://example.com/logo.png" alt="Logo" /></p>';
    expect(sanitizeSignatureHtml(html)).toBe(html);
  });

  it("strips executable markup and unsafe image/link URLs before persistence", () => {
    const { signature } = userSettingsSchema.parse({
      signature:
        '<script>alert(1)</script><p onclick="alert(1)">Alex</p><img src="data:image/svg+xml,evil" onerror="alert(1)"><a href="javascript:alert(1)">Link</a><iframe src="https://evil.test"></iframe><style>body{display:none}</style>',
    });
    expect(signature).toBe("<p>Alex</p><img /><a>Link</a>");
  });

  it("bounds stored markup size", () => {
    expect(userSettingsSchema.safeParse({ signature: "a".repeat(100_001) }).success).toBe(false);
  });
});

it("persists simultaneous partial preferences and keeps other mailboxes independent", async () => {
  const { settingsRouter } = await import("../src/trpc/routes/settings");
  const { buildContext } = await import("../src/ctx");
  const caller = (email: string) => settingsRouter.createCaller(buildContext({
    sessionId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000), email, name: null, password: "test",
    imapHost: "mail.test", imapPort: 993, smtpHost: "mail.test", smtpPort: 587,
  }));
  const alice = caller(crypto.randomUUID() + "@a.test");
  const bob = caller(crypto.randomUUID() + "@b.test");
  await Promise.all([alice.save({ signatureEnabled: true }), alice.save({ timezone: "Africa/Cairo" }), bob.save({ language: "fr" })]);
  expect((await alice.get()).settings).toMatchObject({ signatureEnabled: true, timezone: "Africa/Cairo", language: "en" });
  expect((await bob.get()).settings).toMatchObject({ signatureEnabled: false, timezone: "UTC", language: "fr" });
});

import { describe, it, expect, vi } from "vitest";

/**
 * The `msteams` channel's creation-time allowlist is the only thing standing
 * between a Teams webhook URL and a 400. Microsoft moved Teams webhook
 * workflows off `*.logic.azure.com` and onto
 * `*.<region>.environment.api.powerplatform.com`, so the Workflows template
 * every user is told to use ("Send webhook alerts to a channel") was rejected
 * outright — see #1027.
 *
 * The allowlist is a host suffix match, and that is what keeps
 * `evil-logic.azure.com.attacker.io` out, so the last assertion locks the
 * lookalike half in: widening the accepted suffixes must not widen them into a
 * substring match.
 */

// Only the sanitizer matters here, so the channel row is a stub — no PGlite.
vi.mock("@repo/db", () => ({
  repos: {
    notificationChannel: {
      create: async (input: Record<string, unknown>) => ({
        id: "chn-1",
        verified: false,
        enabled: true,
        ...input,
      }),
    },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: { CLOUD_MODE: false, NOTIFY_WEBHOOK_ALLOW_INTERNAL: false },
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ encrypt: (v: string) => v }));
vi.mock("@repo/platform/engine/lib/ssrf-guard", () => ({
  assertPublicUrlLiteral: () => {},
  SsrfError: class extends Error {},
}));
vi.mock("@repo/platform/engine/lib/notification-workers", () => ({
  sendTestToChannel: async () => {},
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: async () => {} },
  operationAuditContext: () => ({}),
}));

import { createChannel } from "@repo/platform/engine/modules/notifications/notifications.service";

const ctx = { userId: "user-1" } as never;
const WORKFLOW =
  "https://contoso.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke";

async function accept(webhookUrl: string) {
  return createChannel(ctx, { kind: "msteams", label: "Teams", config: { webhookUrl } });
}

describe("msteams channel webhook URL allowlist", () => {
  it("accepts the host Teams' own workflow templates issue", async () => {
    const created = await accept(WORKFLOW);
    expect(created.channel.config).toEqual({ webhookUrlConfigured: true });
  });

  it("accepts the same URL with an explicit default port", async () => {
    const withPort =
      "https://contoso.12.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc";
    await expect(accept(withPort).then((r) => r.channel.config)).resolves.toEqual({
      webhookUrlConfigured: true,
    });
  });

  it("still accepts the pre-migration Power Automate and legacy connector hosts", async () => {
    await expect(
      accept("https://prod-30.westus.logic.azure.com:443/workflows/abc").then(
        (r) => r.channel.config,
      ),
    ).resolves.toEqual({ webhookUrlConfigured: true });
    await expect(
      accept("https://contoso.webhook.office.com/webhookb2/abc").then((r) => r.channel.config),
    ).resolves.toEqual({ webhookUrlConfigured: true });
  });

  it("still rejects other hosts, lookalike suffixes and non-https schemes", async () => {
    for (const webhookUrl of [
      "https://contoso.logic.azure.com.attacker.io/workflows/abc",
      "https://evil-environment.api.powerplatform.com.attacker.io/x",
      "https://powerplatform.com/x",
      "https://attacker.io/redirect?to=contoso.environment.api.powerplatform.com",
      "http://contoso.12.environment.api.powerplatform.com/x",
      "https://169.254.169.254/latest/meta-data/",
    ]) {
      await expect(accept(webhookUrl)).rejects.toMatchObject({
        message: "Invalid Microsoft Teams webhook URL",
      });
    }
  });
});

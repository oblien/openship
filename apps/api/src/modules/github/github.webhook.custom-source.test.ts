import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  collectSourceSecrets: vi.fn(),
  findProjects: vi.fn(),
  findBindings: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findByGitRepo: h.findProjects },
    cloudWebhookBinding: { findByRepo: h.findBindings },
    webhookDelivery: {
      claimGithub: vi.fn(),
      markProcessed: vi.fn(),
    },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: { GITHUB_WEBHOOK_SECRET: "legacy-app-secret" },
}));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({
  collectGitHubSourceWebhookSecrets: h.collectSourceSecrets,
}));
vi.mock("./webhook-installation", () => ({ handleInstallation: vi.fn() }));
vi.mock("./webhook-push", () => ({ handlePush: vi.fn() }));
vi.mock("./webhook-check-run", () => ({ handleCheckRun: vi.fn() }));

import { githubWebhookProvider } from "./github.webhook";

function signature(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("custom GitHub App webhook verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findProjects.mockResolvedValue([]);
    h.findBindings.mockResolvedValue([]);
    h.collectSourceSecrets.mockResolvedValue(["workspace-app-secret"]);
  });

  it("resolves the source from installation metadata and accepts its direct webhook secret", async () => {
    const payload = JSON.stringify({ installation: { id: 42, app_id: 12345 } });

    await expect(
      githubWebhookProvider.verify(payload, {
        "x-github-event": "installation",
        "x-hub-signature-256": signature(payload, "workspace-app-secret"),
      }),
    ).resolves.toEqual({ valid: true });
    expect(h.collectSourceSecrets).toHaveBeenCalledWith({
      installationId: 42,
      appId: 12345,
      allowAllFallback: false,
    });
  });

  it("does not accept the legacy App secret for a recognized custom-App delivery", async () => {
    const payload = JSON.stringify({ installation: { id: 42, app_id: 12345 } });

    await expect(
      githubWebhookProvider.verify(payload, {
        "x-github-event": "installation",
        "x-hub-signature-256": signature(payload, "legacy-app-secret"),
      }),
    ).resolves.toEqual({ valid: false, error: "Invalid signature" });
  });

  it("allows ping to try active source secrets when GitHub omits installation metadata", async () => {
    const payload = JSON.stringify({ zen: "Keep it logically awesome." });

    await githubWebhookProvider.verify(payload, {
      "x-github-event": "ping",
      "x-hub-signature-256": signature(payload, "workspace-app-secret"),
    });

    expect(h.collectSourceSecrets).toHaveBeenCalledWith({
      installationId: undefined,
      appId: undefined,
      allowAllFallback: true,
    });
  });
});

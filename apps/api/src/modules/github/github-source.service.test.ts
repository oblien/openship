import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sourceList: vi.fn(),
  sourceListActive: vi.fn(),
  sourceFindById: vi.fn(),
  sourceFindActiveById: vi.fn(),
  sourceNameTaken: vi.fn(),
  sourceAppTaken: vi.fn(),
  sourceCreate: vi.fn(),
  sourceCreateFromManifest: vi.fn(),
  installationList: vi.fn(),
  stateFind: vi.fn(),
  stateCreate: vi.fn(),
  statePurge: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  appFetch: vi.fn(),
  invalidateOrg: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    gitSource: {
      listByOrganization: h.sourceList,
      listActiveByOrganization: h.sourceListActive,
      findById: h.sourceFindById,
      findActiveById: h.sourceFindActiveById,
      nameTaken: h.sourceNameTaken,
      appTaken: h.sourceAppTaken,
      create: h.sourceCreate,
      createFromManifestState: h.sourceCreateFromManifest,
    },
    gitInstallation: { listAllByOrganization: h.installationList },
    githubInstallState: {
      find: h.stateFind,
      create: h.stateCreate,
      purgeExpired: h.statePurge,
    },
  },
}));
vi.mock("@repo/platform/engine/lib/credential-encryption", () => ({
  encryptSecretField: h.encrypt,
  decryptSecretField: h.decrypt,
}));
vi.mock("@repo/platform/engine/lib/public-url", () => ({
  getInstanceReachability: vi.fn(async () => ({
    configured: true,
    url: "https://ship.example",
  })),
  resolveDashboardPublicUrl: vi.fn(() => "https://ship.example"),
  sharedWebhookUrl: vi.fn(() => "https://ship.example/api/webhooks/github"),
}));
vi.mock("@repo/platform/engine/modules/github/github.app-client", () => ({ githubAppFetch: h.appFetch }));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({ invalidateOrgGitHubCache: h.invalidateOrg }));

import {
  beginGitHubManifestFlow,
  convertGitHubManifest,
  createManualGitHubSource,
} from "@repo/platform/engine/modules/github/github-source.service";

const now = new Date("2026-01-01T00:00:00.000Z");
const ctx = {
  userId: "user_1",
  organizationId: "org_1",
  role: "owner",
} as any;

function storedSource(overrides: Record<string, unknown> = {}) {
  return {
    id: "src_1",
    organizationId: "org_1",
    provider: "github",
    name: "Acme GitHub",
    appId: 12345,
    slug: "acme-app",
    clientId: "Iv1.client",
    appName: "Acme App",
    avatarUrl: "https://avatars.example/app.png",
    apiBaseUrl: "https://api.github.com",
    webBaseUrl: "https://github.com",
    webhookUrl: "https://ship.example/api/webhooks/github",
    secretsEnc: "enc1:ciphertext-only",
    isDefault: true,
    status: "active",
    lastVerifiedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workspace GitHub source service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sourceList.mockResolvedValue([]);
    h.sourceListActive.mockResolvedValue([]);
    h.sourceNameTaken.mockResolvedValue(false);
    h.sourceAppTaken.mockResolvedValue(false);
    h.installationList.mockResolvedValue([]);
    h.statePurge.mockResolvedValue(0);
    h.stateCreate.mockResolvedValue(undefined);
    h.encrypt.mockImplementation(
      (plain: string) => `enc1:${Buffer.from(plain).toString("base64")}`,
    );
    h.decrypt.mockImplementation((stored: string) =>
      Buffer.from(stored.replace(/^enc1:/, ""), "base64").toString("utf8"),
    );
    h.invalidateOrg.mockResolvedValue(undefined);
  });

  it("encrypts manual credentials and never returns secret material", async () => {
    h.appFetch.mockResolvedValue({
      id: 12345,
      slug: "acme-app",
      name: "Acme App",
      client_id: "Iv1.generated",
      owner: { avatar_url: "https://avatars.example/app.png" },
    });
    h.sourceCreate.mockImplementation(async (input: Record<string, unknown>) =>
      storedSource({ ...input, id: "src_manual", isDefault: true }),
    );

    const result = await createManualGitHubSource("org_1", {
      name: "  Acme GitHub  ",
      appId: 12345,
      clientSecret: "client-secret-value",
      privateKeyPem: "private-key-value",
      webhookSecret: "webhook-secret-value",
      apiBaseUrl: "https://github.acme.test/api/v3/",
      webBaseUrl: "https://github.acme.test/",
    });

    expect(h.appFetch).toHaveBeenCalledWith(
      {
        appId: 12345,
        privateKeyPem: "private-key-value",
        apiBaseUrl: "https://github.acme.test/api/v3",
      },
      "/app",
    );
    const encryptedPlaintext = h.encrypt.mock.calls[0][0] as string;
    expect(JSON.parse(encryptedPlaintext)).toEqual({
      privateKeyPem: "private-key-value",
      clientSecret: "client-secret-value",
      webhookSecret: "webhook-secret-value",
    });
    expect(h.sourceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        name: "Acme GitHub",
        apiBaseUrl: "https://github.acme.test/api/v3",
        webBaseUrl: "https://github.acme.test",
        secretsEnc: expect.stringMatching(/^enc1:/),
      }),
    );
    expect(result).not.toHaveProperty("secretsEnc");
    expect(JSON.stringify(result)).not.toContain("private-key-value");
    expect(JSON.stringify(result)).not.toContain("webhook-secret-value");
    expect(JSON.stringify(result)).not.toContain("client-secret-value");
  });

  it("redacts upstream verification failures before returning them", async () => {
    h.appFetch.mockRejectedValue(
      new Error("GitHub App API error (401): key private-key-value is invalid"),
    );

    const work = createManualGitHubSource("org_1", {
      name: "Acme GitHub",
      appId: 12345,
      privateKeyPem: "private-key-value",
      webhookSecret: "webhook-secret-value",
    });

    await expect(work).rejects.toThrow("GitHub rejected the App credentials (HTTP 401).");
    await expect(work).rejects.not.toThrow("private-key-value");
    expect(h.sourceCreate).not.toHaveBeenCalled();
  });

  it("builds a state-bound least-privilege GitHub manifest", async () => {
    const result = await beginGitHubManifestFlow(ctx, { name: "Acme Production" });

    expect(result.url).toBe("https://github.com/settings/apps/new");
    expect(result.manifest).toMatchObject({
      url: "https://ship.example",
      redirect_url: expect.stringMatching(
        /^https:\/\/ship\.example\/auth\/callback\/github-app\?flow=manifest&state=/,
      ),
      setup_url: "https://ship.example/auth/callback/github-app",
      public: false,
      request_oauth_on_install: false,
      hook_attributes: {
        url: "https://ship.example/api/webhooks/github",
        active: true,
      },
      default_permissions: {
        checks: "write",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
        statuses: "write",
      },
      default_events: ["check_run", "pull_request", "push"],
    });
    expect(h.stateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        organizationId: "org_1",
        flow: "manifest",
        payload: {
          name: "Acme Production",
          apiBaseUrl: "https://api.github.com",
          webBaseUrl: "https://github.com",
        },
      }),
    );
    expect(JSON.stringify(result.manifest)).not.toContain("secret");
  });

  it("persists manifest credentials through an atomic one-shot state consume", async () => {
    const source = storedSource({ id: "src_manifest" });
    h.stateFind.mockResolvedValue({
      state: "manifest-state",
      userId: "user_1",
      organizationId: "org_1",
      sourceId: null,
      flow: "manifest",
      payload: {
        name: "Acme GitHub",
        apiBaseUrl: "https://api.github.com",
        webBaseUrl: "https://github.com",
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    h.sourceCreateFromManifest.mockResolvedValueOnce(source).mockResolvedValueOnce(null);
    h.sourceFindActiveById.mockResolvedValue(source);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 12345,
              slug: "acme-app",
              name: "Acme App",
              client_id: "Iv1.client",
              client_secret: "manifest-client-secret",
              pem: "manifest-private-key",
              webhook_secret: "manifest-webhook-secret",
            }),
            { status: 200 },
          ),
      ),
    );

    const first = await convertGitHubManifest(ctx, {
      state: "manifest-state",
      code: "one-shot-code",
    });
    expect(first.installUrl).toMatch(
      /^https:\/\/github\.com\/apps\/acme-app\/installations\/new\?state=/,
    );
    expect(first.source).not.toHaveProperty("secretsEnc");
    expect(h.sourceCreateFromManifest).toHaveBeenCalledWith(
      "manifest-state",
      "user_1",
      "org_1",
      expect.objectContaining({ secretsEnc: expect.stringMatching(/^enc1:/) }),
    );

    await expect(
      convertGitHubManifest(ctx, {
        state: "manifest-state",
        code: "replayed-code",
      }),
    ).rejects.toThrow("already used");
  });
});

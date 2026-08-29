import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pin-down for what LocalGitHubSource puts ON THE WIRE about the gh-side
 * credential.
 *
 * The regression these lock: `getHome()` and `getConnectionState()` each built
 * the `ghCli` state object inline and both omitted `method`, so a pasted PAT
 * reached the dashboard indistinguishable from a credential probed off the
 * host's `gh` login. The card labelled it "gh CLI on this host" (the frontend's
 * `?? "host-cli"` fallback) and the library asked for consent to read a host gh
 * login that was never involved. `github.auth.ts:getGitHubConnectionState` set
 * the field correctly and is not on either path, which is why it looked wired.
 */

const { resolveGitHubAuthMode } = vi.hoisted(() => ({ resolveGitHubAuthMode: vi.fn() }));

vi.mock("../../../src/modules/github/github.auth", () => ({
  resolveGitHubAuthMode,
  getGitHubConnectionState: vi.fn(),
  getInstallationId: vi.fn(),
  getInstallationToken: vi.fn(),
  getUserInstallations: vi.fn(),
  getUserStatus: vi.fn(),
  resolveInstallUrl: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.service", () => ({
  listUserOwnedRepos: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.token", () => ({
  tokenFor: vi.fn(),
  canResolveTokenFor: vi.fn(),
}));

vi.mock("../../../src/config/env", () => ({
  env: {},
  runtimeTarget: { id: "local" },
}));

import { LocalGitHubSource } from "../../../src/modules/github/sources/local-source";

const ctx = { userId: "user-1", organizationId: "org-1" } as never;

/** A stand-in gh sub-source that reports exactly the probe result under test. */
function fakeGh(status: unknown) {
  return {
    status: vi.fn().mockResolvedValue(status),
    listAllRepos: vi.fn().mockResolvedValue([]),
    listOwners: vi.fn().mockResolvedValue([]),
    token: vi.fn(),
  } as never;
}

const OK_TOKEN = {
  available: true as const,
  login: "hydralerne",
  id: 7,
  avatar_url: "https://avatars/1",
  method: "token" as const,
  checkedAt: "2026-07-31T10:00:00.000Z",
};

beforeEach(() => {
  resolveGitHubAuthMode.mockReset();
  // "cli" → app() resolves to null, so both paths exercise the gh side alone.
  resolveGitHubAuthMode.mockResolvedValue("cli");
});

describe("LocalGitHubSource — gh credential on the wire", () => {
  describe("getConnectionState (the Settings card)", () => {
    it("reports the method a pasted token was connected with, not host-cli", async () => {
      const src = new LocalGitHubSource(ctx, fakeGh(OK_TOKEN));

      const state = await src.getConnectionState();

      expect(state.sources.ghCli.method).toBe("token");
      expect(state.sources.ghCli.login).toBe("hydralerne");
      expect(state.sources.ghCli.available).toBe(true);
      expect(state.primary).toBe("gh-cli");
    });

    it("passes through a device sign-in as device", async () => {
      const src = new LocalGitHubSource(ctx, fakeGh({ ...OK_TOKEN, method: "device" }));

      expect((await src.getConnectionState()).sources.ghCli.method).toBe("device");
    });

    it("still reports host-cli for a credential probed off the host gh login", async () => {
      const src = new LocalGitHubSource(ctx, fakeGh({ ...OK_TOKEN, method: "host-cli" }));

      expect((await src.getConnectionState()).sources.ghCli.method).toBe("host-cli");
    });

    it("carries the rejection so the UI can distinguish it from 'nothing connected'", async () => {
      const src = new LocalGitHubSource(
        ctx,
        fakeGh({
          available: false,
          method: "token",
          problem: "rejected",
          checkedAt: "2026-07-31T10:00:00.000Z",
        }),
      );

      const state = await src.getConnectionState();

      expect(state.sources.ghCli.available).toBe(false);
      expect(state.sources.ghCli.problem).toBe("rejected");
      // Naming the broken credential is the point — "reconnect your token" and
      // "your host's gh login expired" send the operator to different places.
      expect(state.sources.ghCli.method).toBe("token");
      expect(state.primary).toBeNull();
    });

    it("reports an unreachable GitHub as such, never as a bad credential", async () => {
      const src = new LocalGitHubSource(
        ctx,
        fakeGh({
          available: false,
          method: "device",
          problem: "unreachable",
          checkedAt: "2026-07-31T10:00:00.000Z",
        }),
      );

      expect((await src.getConnectionState()).sources.ghCli.problem).toBe("unreachable");
    });

    it("emits NO problem when there is no credential at all", async () => {
      // `problem` means "something is stored and broken". A fresh install must
      // not render a fault banner.
      const src = new LocalGitHubSource(ctx, null);

      const state = await src.getConnectionState();

      expect(state.sources.ghCli.available).toBe(false);
      expect(state.sources.ghCli.problem).toBeUndefined();
      expect(state.sources.ghCli.method).toBeUndefined();
      expect(state.primary).toBeNull();
    });
  });

  describe("getHome (the library)", () => {
    it("carries the method, so the first-run consent gate sees the truth", async () => {
      // library/page.tsx gates the "may Openship use your host's gh login?"
      // prompt on method === "host-cli" (via `?? "host-cli"`), so dropping the
      // field asked for consent covering a credential the operator had just
      // typed in themselves.
      const src = new LocalGitHubSource(ctx, fakeGh(OK_TOKEN));

      const home = await src.getHome();

      expect(home.state.sources.ghCli.method).toBe("token");
      expect(home.state.primary).toBe("gh-cli");
    });

    it("keeps host-cli distinguishable on the same path", async () => {
      const src = new LocalGitHubSource(ctx, fakeGh({ ...OK_TOKEN, method: "host-cli" }));

      expect((await src.getHome()).state.sources.ghCli.method).toBe("host-cli");
    });
  });
});

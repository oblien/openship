import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({ repos: { user: { findFoundingAdmin: async () => ({ id: "founder" }) } } }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: { CLOUD_MODE: false, DEPLOY_MODE: "bare", SERVER_IP: "203.0.113.10" } }));
import { assertServerExecution } from "@repo/platform/engine/modules/system/server-access";

const server = { organizationId: "org_founder", sshHost: "127.0.0.1", sshPort: 22, isLocal: false, sshAuthMethod: "key", sshPrivateKey: "explicit-key" };
beforeEach(() => {
  vi.stubEnv("OPENSHIP_NATIVE", "true");
  vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
});
afterEach(() => vi.unstubAllEnvs());

it.each(["127.0.0.1", "203.0.113.10"])("requires native host opt-in for an unadopted local row at %s", async sshHost => {
  await expect(assertServerExecution({ ...server, sshHost } as never)).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
});

it("keeps another organization's loopback SSH target outside the local-host shortcut", async () => {
  await expect(assertServerExecution({ ...server, organizationId: "org_tenant" } as never)).resolves.toBeUndefined();
});

it("retains explicit host opt-in and deliberate local SSH forwards", async () => {
  await expect(assertServerExecution({ ...server, sshPort: 2222 } as never)).resolves.toBeUndefined();
  vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "true");
  await expect(assertServerExecution(server as never)).resolves.toBeUndefined();
});

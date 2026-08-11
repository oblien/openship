import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * A containerized edge (`openship-edge`, run with `--network host`) permanently
 * owns :80/:443, so the mail setup must not install or start a HOST OpenResty
 * on such a box — that unit can never bind, and trying leaves the .deb
 * unconfigured (breaking the next `apt-get upgrade`).
 *
 * Only the installers are mocked: `ourEdgeContainerRunning` runs for real
 * against the fake executor, so these tests cover the actual detection the
 * steps rely on, not a restatement of it.
 */
const mocks = vi.hoisted(() => ({
  installRsync: vi.fn(async () => ({ success: true, version: "3.4.1" })),
  installOpenResty: vi.fn(async () => ({ success: true, version: "1.27" })),
  installCertbot: vi.fn(async () => ({ success: true, version: "2.11" })),
  foreignProxyOnEdge: vi.fn(async () => ({ blocked: false, owner: null })),
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  installRsync: mocks.installRsync,
  installOpenResty: mocks.installOpenResty,
  installCertbot: mocks.installCertbot,
  foreignProxyOnEdge: mocks.foreignProxyOnEdge,
}));

import {
  stepEnsureComponents,
  stepEnsureReverseProxy,
} from "../../../src/modules/mail/mail.service";

/** Records every command so a test can assert what was NOT run. */
function fakeExecutor(responses: (cmd: string) => string) {
  const commands: string[] = [];
  const exec = async (cmd: string) => {
    commands.push(cmd);
    return responses(cmd);
  };
  return { commands, executor: { exec } as never };
}

/** Stands in for this box: `docker ps` finds our edge container. */
const withContainerEdge = (cmd: string) =>
  cmd.includes("docker ps") && cmd.includes("openship-edge") ? "openship-edge\n" : "";

/** A plain VPS: no docker, so the probe finds nothing. */
const withoutContainerEdge = (cmd: string) =>
  cmd.includes("systemctl is-active") ? "active\n" : "";

describe("mail setup on a containerized-edge box", () => {
  beforeEach(() => vi.clearAllMocks());

  test("step 2 installs rsync + certbot but skips the host OpenResty", async () => {
    const { executor } = fakeExecutor(withContainerEdge);
    const logs: string[] = [];

    const result = await stepEnsureComponents(executor, "example.com", (_id, _lvl, msg) =>
      logs.push(msg),
    );

    expect(result.success).toBe(true);
    expect(mocks.installOpenResty).not.toHaveBeenCalled();
    expect(mocks.installRsync).toHaveBeenCalledOnce();
    expect(mocks.installCertbot).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("Skipping OpenResty");
    expect(result.message).toContain("containerized edge");
  });

  test("step 4 never touches the host openresty unit", async () => {
    const { executor, commands } = fakeExecutor(withContainerEdge);

    const result = await stepEnsureReverseProxy(executor, "example.com", () => {});

    expect(result.success).toBe(true);
    expect(commands.some((c) => c.includes("systemctl start openresty"))).toBe(false);
    expect(commands.some((c) => c.includes("systemctl is-active openresty"))).toBe(false);
  });
});

describe("mail setup on a bare-host box (unchanged behavior)", () => {
  beforeEach(() => vi.clearAllMocks());

  test("step 2 still installs OpenResty when no edge container is running", async () => {
    const { executor } = fakeExecutor(withoutContainerEdge);

    const result = await stepEnsureComponents(executor, "example.com", () => {});

    expect(result.success).toBe(true);
    expect(mocks.installOpenResty).toHaveBeenCalledOnce();
    expect(result.message).toContain("OpenResty");
  });

  test("step 4 still checks the openresty service when no edge container is running", async () => {
    const { executor, commands } = fakeExecutor(withoutContainerEdge);

    const result = await stepEnsureReverseProxy(executor, "example.com", () => {});

    expect(result.success).toBe(true);
    expect(commands.some((c) => c.includes("systemctl is-active openresty"))).toBe(true);
  });
});

import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * There is ONE edge on a box and it is the `openship-edge` container.
 *
 * The mail wizard used to apt-install a HOST OpenResty and certbot, which made it
 * the only flow with its own edge story — a second implementation of the same
 * thing, its own conflict handling, and a host certbot that only mail's cert step
 * used. On a box that already ran the container edge (host networking, so it owns
 * :80/:443 permanently) the host unit could never bind: the apt postinst started
 * it, the bind failed, and dpkg was left half-configured, breaking every later
 * `apt-get`.
 *
 * These tests pin the invariant that replaced it: mail installs rsync + Docker and
 * then goes through the shared `ensureEdge` orchestrator, and NOTHING ever
 * apt-installs an edge. `installOpenResty`/`installCertbot` no longer exist, so a
 * regression can't be mocked back into place — the assertion is on the commands
 * and on which shared installer was called.
 */
const mocks = vi.hoisted(() => ({
  installRsync: vi.fn(async () => ({ component: "rsync", success: true, version: "3.4.1" })),
  installDocker: vi.fn(async () => ({ component: "docker", success: true, version: "27.1" })),
  installContainerEdge: vi.fn(async () => ({
    component: "edge",
    success: true,
    version: "1.27.1",
  })),
  foreignProxyOnEdge: vi.fn(async () => ({
    status: { classification: "ours", occupants: [], canProceedClean: true },
    blocked: false,
    owner: "",
  })),
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  installRsync: mocks.installRsync,
  installDocker: mocks.installDocker,
  installContainerEdge: mocks.installContainerEdge,
  foreignProxyOnEdge: mocks.foreignProxyOnEdge,
}));

import {
  stepEnsureComponents,
  stepEnsureReverseProxy,
} from "../../../src/modules/mail/mail.service";

/** Records every command so a test can assert what was NOT run. */
function fakeExecutor(responses: (cmd: string) => string = () => "") {
  const commands: string[] = [];
  const exec = async (cmd: string) => {
    commands.push(cmd);
    return responses(cmd);
  };
  return { commands, executor: { exec } as never };
}

beforeEach(() => vi.clearAllMocks());

describe("step 1 — Docker, then the container edge", () => {
  test("installs Docker and ensures the edge (no rsync — the engine is a prebuilt image)", async () => {
    const { executor } = fakeExecutor();
    const logs: string[] = [];

    const result = await stepEnsureComponents(executor, "example.com", (_id, _lvl, m) =>
      logs.push(m),
    );

    expect(result.success).toBe(true);
    // rsync is gone: nothing is staged to the host any more (the mail engine ships
    // as the openship-mail image), so the step installs Docker + brings up the edge.
    expect(mocks.installRsync).not.toHaveBeenCalled();
    expect(mocks.installDocker).toHaveBeenCalledOnce();
    expect(mocks.installContainerEdge).toHaveBeenCalledOnce();
    expect(result.message).toContain("edge");
  });

  test("never apt-installs openresty, nginx, or certbot", async () => {
    const { executor, commands } = fakeExecutor();

    await stepEnsureComponents(executor, "example.com", () => {});

    // The step itself must issue no package command for an edge — and the only
    // installers it can reach are rsync/docker/edge.
    const all = commands.join("\n");
    expect(all).not.toMatch(/apt-get install[^\n]*(openresty|nginx|certbot)/);
    expect(all).not.toMatch(/systemctl (start|enable) openresty/);
  });

  test("a Docker-less box fails with the edge's own actionable message", async () => {
    // installContainerEdge gates on dockerAvailable and returns this rather than
    // falling back to a host package — the whole point of having one edge.
    mocks.installContainerEdge.mockResolvedValueOnce({
      component: "edge",
      success: false,
      error: "The edge is a container image and needs Docker on this server.",
    } as never);
    const { executor } = fakeExecutor();

    const result = await stepEnsureComponents(executor, "example.com", () => {});

    expect(result.success).toBe(false);
    expect(result.message).toContain("needs Docker");
  });

  test("a failed edge migration fails the step instead of reporting success", async () => {
    // ensureEdge rolls back to the previous proxy on a failed migrate; the step
    // must not read that as "edge ready".
    mocks.installContainerEdge.mockImplementationOnce(async () => {
      const { EdgeMigrateRequested } = await import("@repo/adapters");
      throw new EdgeMigrateRequested(
        { classification: "foreign", occupants: [], canProceedClean: false },
        [],
        [],
      );
    });
    const { executor } = fakeExecutor();

    const result = await stepEnsureComponents(executor, "example.com", () => {});

    // No promptUser is passed today, so the takeover can't succeed here; either way
    // the step must not claim the edge is ready.
    expect(result.success).toBe(false);
  });
});

describe("step 4 — verification only", () => {
  test("confirms our edge holds the ports without touching a host unit", async () => {
    const { executor, commands } = fakeExecutor();

    const result = await stepEnsureReverseProxy(executor, "example.com", () => {});

    expect(result.success).toBe(true);
    expect(commands.some((c) => c.includes("systemctl is-active openresty"))).toBe(false);
    expect(commands.some((c) => c.includes("systemctl start openresty"))).toBe(false);
  });

  test("a foreign proxy is refused, never taken over", async () => {
    mocks.foreignProxyOnEdge.mockResolvedValueOnce({
      status: { classification: "foreign", occupants: [], canProceedClean: false },
      blocked: true,
      owner: "caddy",
    } as never);
    const { executor } = fakeExecutor();

    const result = await stepEnsureReverseProxy(executor, "example.com", () => {});

    expect(result.success).toBe(false);
    expect(result.message).toContain("caddy");
    expect(result.message).toContain("migrate it from the dashboard");
  });

  test("nothing serving means the edge isn't up — point back at step 2", async () => {
    mocks.foreignProxyOnEdge.mockResolvedValueOnce({
      status: { classification: "free", occupants: [], canProceedClean: true },
      blocked: false,
      owner: "",
    } as never);
    const { executor } = fakeExecutor();

    const result = await stepEnsureReverseProxy(executor, "example.com", () => {});

    expect(result.success).toBe(false);
    expect(result.message).toContain("isn't running");
  });
});

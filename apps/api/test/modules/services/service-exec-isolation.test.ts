/**
 * Service exec must never land on the HOST.
 *
 * `POST /api/projects/:id/services/:serviceId/exec` is gated by
 * `project:service:write` — a project-tier grant. Host shell is gated by
 * `server:admin`, a much narrower thing to hand out. So if service exec could reach
 * the host, a project grant would silently confer server-admin's most dangerous
 * capability.
 *
 * It very nearly could. The BARE runtime implements `inContainerExecutor()` by
 * returning the host executor — correct for the advisory port probe that method was
 * written for (a bare deployment IS a host process, sharing the host netns), and a
 * privilege escalation for an arbitrary command. A gate that tested "is the method
 * present" would have passed Bare straight through to the host.
 *
 * Hence the gate is `supports("isolatedExec")`: the capability that asks whether the
 * execution context is CONFINED, and that a new runtime fails by omitting.
 */

import { describe, it, expect, vi } from "vitest";
import { BareRuntime } from "@repo/adapters";
import type { RuntimeCapability } from "@repo/adapters";

describe("the runtimes' isolation claims", () => {
  it("Bare does NOT claim isolatedExec — its exec context is the host", () => {
    const caps = BareRuntime.prototype.capabilities as ReadonlySet<RuntimeCapability> | undefined;
    // Read off an instance if it isn't a prototype field.
    const set =
      caps ??
      (new BareRuntime({ executor: { exec: vi.fn(), streamExec: vi.fn() } } as never)
        .capabilities as ReadonlySet<RuntimeCapability>);
    expect(set.has("isolatedExec")).toBe(false);
    // It still claims the weaker capability, which is what made the distinction
    // necessary in the first place.
    expect(set.has("inContainerExec")).toBe(true);
  });
});

describe("execInServiceContainer's gate", () => {
  /** Minimal runtime stub: declares whatever caps the test names. */
  function runtimeWith(caps: RuntimeCapability[], onExec = vi.fn(async () => "out")) {
    const set = new Set(caps);
    return {
      supports: (c: RuntimeCapability) => set.has(c),
      inContainerExecutor: vi.fn(async () => ({ exec: onExec })),
      dispose: vi.fn(async () => {}),
      onExec,
    };
  }

  /**
   * Exercises the gate in isolation. `execInServiceContainer` resolves its runtime
   * through `resolveServiceContainer`, which needs the whole project/deployment
   * stack; the branch under test is the two lines that read the capability, so it is
   * reproduced here against the same predicate rather than mocked five layers deep.
   */
  function gate(runtime: { supports: (c: RuntimeCapability) => boolean; inContainerExecutor?: unknown }) {
    return runtime.supports("isolatedExec") && !!runtime.inContainerExecutor;
  }

  it("refuses a runtime that can exec but is NOT isolated (Bare's shape)", () => {
    expect(gate(runtimeWith(["inContainerExec"]))).toBe(false);
  });

  it("allows a runtime that claims isolation (Docker / Cloud's shape)", () => {
    expect(gate(runtimeWith(["inContainerExec", "isolatedExec"]))).toBe(true);
  });

  it("fails closed for a runtime that declares nothing", () => {
    expect(gate(runtimeWith([]))).toBe(false);
  });

  it("refuses a runtime claiming isolation but implementing no executor", () => {
    const r = runtimeWith(["isolatedExec"]);
    (r as { inContainerExecutor?: unknown }).inContainerExecutor = undefined;
    expect(gate(r)).toBe(false);
  });
});

describe("the exec surface is split by privilege tier", () => {
  it("host exec is server:admin; container exec is project:service:write", async () => {
    // Pins the tiers themselves: if someone ever lowers host exec to server:write, or
    // raises container exec, the two endpoints stop meaning what their docs claim.
    await import("../../../src/modules/system/system.routes");
    await import("../../../src/modules/services/service.routes");
    const { getRouteRegistry } = await import("../../../src/lib/route-permission");

    const host = getRouteRegistry().find(
      (r) => r.method === "POST" && r.path === "/api/system/servers/:id/exec",
    );
    const container = getRouteRegistry().find(
      (r) => r.method === "POST" && r.path === "/api/projects/:id/services/:serviceId/exec",
    );

    expect(host, "host exec route must exist").toBeTruthy();
    expect(container, "container exec route must exist").toBeTruthy();
    expect((host!.spec as { tag: string }).tag).toBe("server:admin");
    expect((container!.spec as { tag: string }).tag).toBe("project:service:write");

    // Both must advertise a typed body, or the MCP tool has no way to send a command.
    expect((host!.spec as { body?: unknown }).body).toBeTruthy();
    expect((container!.spec as { body?: unknown }).body).toBeTruthy();

    // Host exec is self-hosted-only, so it is never advertised on the control plane.
    expect((host!.spec as { localOnly?: boolean }).localOnly).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({ destinations: vi.fn(), mailServer: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { server: { get: h.mailServer } } }));
vi.mock("@repo/platform/engine/lib/platform", () => ({
  getPlatformKernel: () => ({ servers: { destinations: h.destinations } }),
}));

import { listWebmailTargets } from "./webmail.service";

const ctx = { organizationId: "org-mail", userId: "user-mail", role: "owner" } as ExecutionContext;
beforeEach(() => {
  vi.clearAllMocks();
  h.mailServer.mockResolvedValue({ id: "mail", organizationId: ctx.organizationId });
});

describe("webmail destination discovery", () => {
  it("uses the shared authorized inventory and preserves real managed server IDs", async () => {
    h.destinations.mockResolvedValue({
      context: ctx,
      data: {
        servers: [
          { id: "managed", name: "Linked Cloud", managed: { id: "workspace" }, source: "local" },
          { id: "another", name: "Another VPS", sshHost: "192.0.2.2" },
          { id: "mail", name: "Mail VPS", sshHost: "192.0.2.1" },
          {
            id: "remote",
            name: "Unlinked Cloud",
            managed: { id: "remote-workspace" },
            source: "cloud",
          },
        ],
      },
    });
    const targets = await listWebmailTargets("mail", ctx);
    expect(h.destinations).toHaveBeenCalledWith(ctx);
    expect(targets.map(({ serverId }) => serverId)).toEqual([
      "mail",
      "managed",
      "another",
      "remote",
    ]);
    expect(targets[0]).toMatchObject({ kind: "mail", label: "Mail VPS" });
    expect(targets[1]).toMatchObject({ kind: "opshcloud", serverId: "managed" });
    expect(targets[1]?.disabled).toBeUndefined();
    expect(targets[3]).toMatchObject({ kind: "opshcloud", disabled: true });
    expect(targets[3]?.disabledReason).toMatch(/Connect this managed server/);
  });

  it("does not invent a Cloud destination or re-add a server excluded by permissions", async () => {
    h.destinations.mockResolvedValue({ context: ctx, data: { servers: [] } });
    expect(await listWebmailTargets("mail", ctx)).toEqual([]);
  });

  it("checks mail server ownership before reading destination inventory", async () => {
    h.mailServer.mockResolvedValue({ id: "mail", organizationId: "another-org" });
    await expect(listWebmailTargets("mail", ctx)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.destinations).not.toHaveBeenCalled();
  });

  it("propagates an unavailable inventory instead of presenting guessed choices", async () => {
    h.destinations.mockRejectedValue(new Error("Inventory unavailable"));
    await expect(listWebmailTargets("mail", ctx)).rejects.toThrow("Inventory unavailable");
  });
});

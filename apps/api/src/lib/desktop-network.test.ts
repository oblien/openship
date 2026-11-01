import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ target: "desktop" as string | null, interfaces: vi.fn() }));
vi.mock("node:os", () => ({ networkInterfaces: h.interfaces }));
vi.mock("@repo/adapters", () => ({ peekPlatform: () => h.target ? { target: h.target } : null }));
import { desktopNetworkDisconnected } from "@repo/platform/engine/lib/desktop-network";

beforeEach(() => {
  h.target = "desktop";
  h.interfaces.mockReset();
});

describe("the monitoring observer's network", () => {
  it.each([{}, { lo0: [{ address: "127.0.0.1", internal: true }] }])(
    "detects a desktop without any external interface: %j",
    (interfaces) => {
      h.interfaces.mockReturnValue(interfaces);
      expect(desktopNetworkDisconnected()).toBe(true);
    },
  );

  it.each(["192.168.1.5", "fe80::1", "10.100.0.2"])(
    "leaves LAN/VPN reachability to the server probe (%s)",
    (address) => {
      h.interfaces.mockReturnValue({ en0: [{ address, internal: false }] });
      expect(desktopNetworkDisconnected()).toBe(false);
    },
  );

  it("does not turn an OS inspection failure into an offline verdict", () => {
    h.interfaces.mockImplementation(() => { throw new Error("OS lookup failed"); });
    expect(desktopNetworkDisconnected()).toBe(false);
  });

  it("leaves connectivity unknown before host adapters are initialized", () => {
    h.target = null;
    expect(desktopNetworkDisconnected()).toBe(false);
    expect(h.interfaces).not.toHaveBeenCalled();
  });

  it.each(["selfhosted", "cloud"])("never applies a desktop verdict to %s", (target) => {
    h.target = target;
    expect(desktopNetworkDisconnected()).toBe(false);
    expect(h.interfaces).not.toHaveBeenCalled();
  });
});

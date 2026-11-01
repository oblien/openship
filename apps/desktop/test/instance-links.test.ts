import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_INSTANCE_SCHEME, desktopInstanceLink } from "@repo/core";
import { InstanceLinkInbox, registerInstanceLinks } from "../src/main/instance-links";

const address = "https://ops.example.test/accept-invite/inv_1";
const link = desktopInstanceLink(address);

describe("Desktop instance link inbox", () => {
  it("preserves pending invitations across renderer reads until the matching acknowledgement", () => {
    const inbox = new InstanceLinkInbox();
    expect(inbox.receive(link)).toBe(true);
    const first = inbox.pending()!;
    expect(inbox.pending()).toEqual({ id: first.id, address });
    expect(inbox.acknowledge(String(first.id))).toBe(false);
    expect(inbox.acknowledge(first.id + 1)).toBe(false);
    expect(inbox.pending()).toEqual(first);
    expect(inbox.acknowledge(first.id)).toBe(true);
    expect(inbox.pending()).toBeNull();
  });

  it("does not let a duplicate or later link replace the active confirmation", () => {
    const inbox = new InstanceLinkInbox();
    inbox.receive(link);
    const first = inbox.pending()!;
    expect(inbox.receive(link)).toBe(false);
    const secondAddress = "https://other.test/accept-invite/inv_2";
    expect(inbox.receive(desktopInstanceLink(secondAddress))).toBe(true);
    expect(inbox.pending()).toEqual(first);
    inbox.acknowledge(first.id);
    expect(inbox.pending()?.address).toBe(secondAddress);
    expect(inbox.acknowledge(first.id)).toBe(false);
  });

  it("rejects unsafe input and bounds the queue without dropping the current request", () => {
    const inbox = new InstanceLinkInbox();
    expect(inbox.receive("openship://connect?url=file:///etc/passwd")).toBe(false);
    for (let i = 0; i < 8; i++)
      expect(inbox.receive(desktopInstanceLink(`https://ops${i}.test`))).toBe(true);
    expect(inbox.receive(link)).toBe(false);
    expect(inbox.pending()?.address).toBe("https://ops0.test");
  });
});

describe("OS link entry points", () => {
  function fixture(locked = true) {
    const app = Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: vi.fn(() => locked),
      quit: vi.fn(),
    });
    const receive = vi.fn();
    const activate = vi.fn();
    const owner = registerInstanceLinks(
      app as Parameters<typeof registerInstanceLinks>[0],
      receive,
      activate,
      ["openship", link],
    );
    return { app, receive, activate, owner };
  }
  it("receives cold-launch argv and warm Windows/Linux launches", () => {
    const f = fixture();
    expect(f.owner).toBe(true);
    expect(f.receive).toHaveBeenCalledExactlyOnceWith(link);
    f.app.emit("second-instance", {}, ["openship", "--inspect", link, "file:///tmp/file"]);
    expect(f.receive).toHaveBeenCalledTimes(2);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });
  it("receives macOS open-url before ready and prevents default handling", () => {
    const f = fixture();
    const event = { preventDefault: vi.fn() };
    f.app.emit("open-url", event, link);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(f.receive).toHaveBeenLastCalledWith(link);
  });
  it("exits the second process before starting another controller", () => {
    const f = fixture(false);
    expect(f.owner).toBe(false);
    expect(f.app.quit).toHaveBeenCalledOnce();
    expect(f.receive).not.toHaveBeenCalled();
    expect(f.app.eventNames()).toEqual([]);
  });
});

it("advertises the same handler in macOS and Linux packages", () => {
  const config = createRequire(import.meta.url)("../forge.config.js");
  expect(config.packagerConfig.protocols[0].schemes).toContain(DESKTOP_INSTANCE_SCHEME);
  for (const kind of ["deb", "rpm"]) {
    const maker = config.makers.find((item: { name: string }) =>
      item.name.endsWith(`maker-${kind}`),
    );
    expect(maker.config.options.mimeType).toContain(`x-scheme-handler/${DESKTOP_INSTANCE_SCHEME}`);
  }
  const maker = config.makers.find((item: { name: string }) =>
    item.name.endsWith("maker-appimage"),
  );
  const desktop = readFileSync(maker.config.options.desktopFile, "utf8");
  expect(desktop).toContain("Exec=openship %U");
  expect(desktop).toContain(`MimeType=x-scheme-handler/${DESKTOP_INSTANCE_SCHEME};`);
});

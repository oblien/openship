import type { App } from "electron";
import { parseDesktopInstanceLink, type DesktopInstanceLinkRequest } from "@repo/core";

/** Keep links in memory until confirmation or dismissal. A renderer reload
 * cannot lose an invitation, and a second link cannot replace a connection
 * already being confirmed. Bound the queue because OS input is untrusted. */
export class InstanceLinkInbox {
  private nextId = 0;
  private requests: DesktopInstanceLinkRequest[] = [];

  receive(value: string): boolean {
    const address = parseDesktopInstanceLink(value);
    if (
      !address ||
      this.requests.length >= 8 ||
      this.requests.some((item) => item.address === address)
    )
      return false;
    this.requests.push({ id: ++this.nextId, address });
    return true;
  }

  pending(): DesktopInstanceLinkRequest | null {
    return this.requests[0] ? { ...this.requests[0] } : null;
  }

  acknowledge(id: unknown): boolean {
    if (typeof id !== "number" || this.requests[0]?.id !== id) return false;
    this.requests.shift();
    return true;
  }
}

/** Register before ready: macOS delivers open-url during startup; Windows and
 * Linux deliver argv on cold launch and second-instance on a running app. */
export function registerInstanceLinks(
  app: Pick<App, "requestSingleInstanceLock" | "quit" | "on">,
  receive: (value: string) => void,
  activate: () => void,
  argv: string[],
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  const receiveArgs = (args: string[]) => {
    for (const value of args) {
      if (parseDesktopInstanceLink(value)) receive(value);
    }
  };
  app.on("open-url", (event, url) => {
    event.preventDefault();
    receive(url);
  });
  app.on("second-instance", (_event, args) => {
    receiveArgs(args);
    activate();
  });
  receiveArgs(argv);
  return true;
}

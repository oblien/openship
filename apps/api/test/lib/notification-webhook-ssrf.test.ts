import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationChannel } from "@repo/db";

/**
 * The webhook worker's SSRF policy is a call-site decision, so it's asserted on
 * the options handed to safeFetch. safeFetch itself owns enforcement (DNS pin,
 * no-redirect, private-range rejection) and is covered by safe-fetch.test.ts —
 * this file only proves the worker asks for the right policy, because a second
 * literal pre-check used to sit in front of it and silently made both opt-ins
 * below unreachable.
 */
const safeFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
const envMock: { CLOUD_MODE: boolean; NOTIFY_WEBHOOK_ALLOW_INTERNAL: boolean } = {
  CLOUD_MODE: false,
  NOTIFY_WEBHOOK_ALLOW_INTERNAL: false,
};

vi.mock("../../src/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetch(...(args as [])),
}));
vi.mock("../../src/config/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../src/lib/mail", () => ({ sendMail: vi.fn() }));
vi.mock("../../src/lib/encryption", () => ({ decrypt: (v: string) => v }));

const { sendTestToChannel } = await import("../../src/lib/notification-workers");

const webhookChannel = (url: string) =>
  ({ id: "ch_1", kind: "webhook", config: { url } }) as unknown as NotificationChannel;

const optsFor = async (url: string) => {
  await sendTestToChannel(webhookChannel(url));
  return safeFetch.mock.calls.at(-1)?.[1] as { allowHttp?: boolean; allowPrivate?: boolean };
};

describe("webhook delivery SSRF policy", () => {
  beforeEach(() => {
    safeFetch.mockClear();
    envMock.CLOUD_MODE = false;
    envMock.NOTIFY_WEBHOOK_ALLOW_INTERNAL = false;
  });

  it("is https-only and public-only on a default self-hosted box", async () => {
    const opts = await optsFor("https://hooks.example.com/x");
    expect(opts.allowHttp).toBe(false);
    expect(opts.allowPrivate).toBe(false);
  });

  it("allows the LAN and plaintext http together under the single-tenant opt-in", async () => {
    // A receiver on the box's own network has no usable cert, so the opt-in has
    // to carry http with it or it delivers nothing.
    envMock.NOTIFY_WEBHOOK_ALLOW_INTERNAL = true;
    const opts = await optsFor("http://10.0.0.5/hook");
    expect(opts.allowHttp).toBe(true);
    expect(opts.allowPrivate).toBe(true);
  });

  it("ignores the opt-in in multi-tenant cloud mode", async () => {
    // One tenant must never aim a webhook at the control plane's own network,
    // and must never get the payload plus its HMAC sent in cleartext.
    envMock.CLOUD_MODE = true;
    envMock.NOTIFY_WEBHOOK_ALLOW_INTERNAL = true;
    const opts = await optsFor("https://hooks.example.com/x");
    expect(opts.allowHttp).toBe(false);
    expect(opts.allowPrivate).toBe(false);
  });

  it("still rejects a channel with no URL before reaching the network", async () => {
    await expect(
      sendTestToChannel({
        id: "ch_2",
        kind: "webhook",
        config: {},
      } as unknown as NotificationChannel),
    ).rejects.toThrow(/no URL/i);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationChannel } from "@repo/db";

const mocks = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("@repo/platform/engine/lib/mail", () => ({ sendMail: mocks.sendMail }));

import { sendTestToChannel } from "@repo/platform/engine/lib/notification-workers";

const channel = {
  id: "ch_email", kind: "email", config: { address: "operator@example.com" },
} as unknown as NotificationChannel;

beforeEach(() => {
  mocks.sendMail.mockReset().mockResolvedValue(true);
});

describe("notification email delivery", () => {
  it("sends structured HTML and the existing plain text through the same mail transport", async () => {
    await sendTestToChannel(channel);
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    const sent = mocks.sendMail.mock.calls[0]![0];
    expect(sent.to).toBe("operator@example.com");
    expect(sent.subject).toBe("[Openship] test");
    expect(sent.text).toBe("Openship test notification — this channel is configured correctly.");
    expect(sent.html).toContain("<h2");
    expect(sent.html).toContain(sent.text);
    expect(sent.html).not.toContain("<pre");
  });

  it("refuses to report delivery when no mail transport accepts the message", async () => {
    mocks.sendMail.mockResolvedValue(false);
    await expect(sendTestToChannel(channel)).rejects.toThrow("No email transport is configured");
  });

  it("preserves transport failures so the notification worker can retry", async () => {
    mocks.sendMail.mockRejectedValue(new Error("SMTP unavailable"));
    await expect(sendTestToChannel(channel)).rejects.toThrow("SMTP unavailable");
  });
});

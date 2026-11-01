import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailInboundRule } from "@repo/db";

const h = vi.hoisted(() => ({
  rules: vi.fn(), mark: vi.fn(), channel: vi.fn(), members: vi.fn(), enqueue: vi.fn(), run: vi.fn(), armed: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: {
  mailInbound: { listEnabledByServer: h.rules, markMatched: h.mark },
  notificationChannel: { findById: h.channel }, member: { listByUser: h.members },
  notificationDelivery: { create: h.enqueue },
} }));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", () => ({
  runMailCommand: h.run, mailEngineCommand: (_flavor: unknown, command: string) => command,
}));
vi.mock("@repo/platform/engine/modules/mail/inbound/capture", () => ({
  readArmedState: h.armed,
  collectorFolderPath: (path: string, token: string) => `${path}/Maildir/.${token}`,
  ruleDomain: (rule: MailInboundRule) => rule.target?.split("@").at(-1),
  tokenFromBcc: () => null,
}));
import { runInboundForServer } from "@repo/platform/engine/modules/mail/inbound/read";

const rule = (id: string, target = "inbox@example.test") => ({
  id, name: id, scope: "mailbox", target, enabled: true, pausedReason: null,
  channelIds: [id], maxSpamScore: null, fromPattern: null, subjectPattern: null,
} as MailInboundRule);
const message = (file: string, recipient = "inbox@example.test", extra = "") =>
  `__OPENSHIP_MSG__ ${file}\nFrom: sender@elsewhere.test\nTo: ${recipient}\nSubject: Hello\n${extra}\n`;
const run = (dryRun = false) => runInboundForServer({ serverId: "server", organizationId: "org", dryRun });
function removals() {
  return h.run.mock.calls.map(([, render]) => render("container")).filter((command: string) => command.startsWith("rm -f"));
}
beforeEach(() => {
  vi.resetAllMocks();
  h.rules.mockResolvedValue([rule("channel")]);
  h.mark.mockResolvedValue(undefined);
  h.armed.mockResolvedValue({ token: "token", maildirPath: "/collector" });
  h.channel.mockImplementation(async (id: string) => ({ id, userId: "user", enabled: true, verified: true, kind: "in_app" }));
  h.members.mockResolvedValue([{ organizationId: "org" }]);
  h.enqueue.mockResolvedValue({ id: "delivery" });
  h.run.mockImplementation(async (_server, render) => ({ output: render("container").startsWith("rm -f") ? "" : message("message-1") }));
});

describe("inbound mail acknowledgement", () => {
  it("deletes only after a durable delivery is queued", async () => {
    h.enqueue.mockImplementation(async () => {
      expect(removals()).toEqual([]);
      return { id: "delivery" };
    });
    expect(await run()).toMatchObject({ emitted: 1, errors: [] });
    expect(removals()).toHaveLength(1);
    expect(removals()[0]).toContain("/new/message-1");
  });

  it.each(["enqueue", "channel", "members"] as const)("retains captured mail when %s fails, then retries after recovery", async (operation) => {
    h[operation].mockRejectedValueOnce(new Error("Database unavailable"));
    const failed = await run();
    expect(failed.errors).toEqual([expect.stringContaining("Database unavailable")]);
    expect(removals()).toEqual([]);
    expect(h.mark).not.toHaveBeenCalled();
    expect(await run()).toMatchObject({ emitted: 1, errors: [] });
    expect(removals()).toHaveLength(1);
  });

  it("prunes unrelated successes and rejected mail while preserving a failed rule's messages", async () => {
    h.rules.mockResolvedValue([rule("failed", "first@example.test"), rule("ok", "second@example.test")]);
    h.run.mockImplementation(async (_server, render) => ({ output: render("container").startsWith("rm -f") ? "" :
      message("retained", "first@example.test") + message("delivered", "second@example.test") + message("bounce", "none@example.test", "Return-Path: <>\n") }));
    h.enqueue.mockImplementation(async (input) => {
      if (input.channelId === "failed") throw new Error("Queue unavailable");
      return { id: "queued" };
    });
    expect(await run()).toMatchObject({ emitted: 1, dropped: 1, errors: [expect.stringContaining("Queue unavailable")] });
    expect(removals()[0]).not.toContain("/new/retained");
    expect(removals()[0]).toContain("/new/delivered");
    expect(removals()[0]).toContain("/new/bounce");
  });

  it("keeps a message when any matching rule could not enqueue it", async () => {
    h.rules.mockResolvedValue([rule("ok"), rule("failed")]);
    h.channel.mockImplementation(async (id: string) => {
      if (id === "failed") throw new Error("Lookup unavailable");
      return { id, userId: "user", enabled: true, verified: true, kind: "in_app" };
    });
    expect((await run()).errors).toHaveLength(1);
    expect(removals()).toEqual([]);
  });

  it("honors the requested organization when the channel owner belongs to several organizations", async () => {
    h.members.mockResolvedValue([{ organizationId: "other" }, { organizationId: "org" }]);
    expect(await run()).toMatchObject({ emitted: 1, errors: [] });
  });

  it("never dispatches or deletes mail in dry-run mode", async () => {
    expect(await run(true)).toMatchObject({ matched: 1, emitted: 0, errors: [] });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(removals()).toEqual([]);
  });
});

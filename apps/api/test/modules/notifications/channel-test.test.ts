import type { Context } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  touchLastDelivered: vi.fn(),
  sendChannelTestMessage: vi.fn(),
  recordAsync: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    notificationChannel: {
      findById: mocks.findById,
      update: mocks.update,
      touchLastDelivered: mocks.touchLastDelivered,
    },
  },
}));

vi.mock("../../../src/lib/notification-workers", () => ({
  sendChannelTestMessage: mocks.sendChannelTestMessage,
}));

vi.mock("../../../src/lib/audit", () => ({
  audit: { recordAsync: mocks.recordAsync },
  auditContextFrom: () => ({ userAgent: "test" }),
}));

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ userId: "user-1", organizationId: "org-1" }),
}));

import { testChannel } from "../../../src/modules/notifications/notifications.controller";

function ctx(param: string | undefined) {
  return {
    req: { param: () => param },
    json: vi.fn((body: unknown, status?: number) => ({ body, status: status ?? 200 })),
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({ id: "nch_1", verified: true });
  mocks.touchLastDelivered.mockResolvedValue(undefined);
});

describe("testChannel", () => {
  test("returns 400 when id is missing", async () => {
    const result = await testChannel(ctx(undefined));
    expect(result).toEqual({ body: { error: "id is required" }, status: 400 });
  });

  test("returns 404 when channel belongs to another user", async () => {
    mocks.findById.mockResolvedValue({ id: "nch_1", userId: "user-2", kind: "email" });
    const result = await testChannel(ctx("nch_1"));
    expect(result).toEqual({ body: { error: "Channel not found" }, status: 404 });
  });

  test("returns 400 for in_app channels", async () => {
    mocks.findById.mockResolvedValue({ id: "nch_1", userId: "user-1", kind: "in_app" });
    const result = await testChannel(ctx("nch_1"));
    expect(result).toEqual({
      body: { error: "In-app channels do not need verification" },
      status: 400,
    });
  });

  test("marks channel verified after a successful test send", async () => {
    mocks.findById.mockResolvedValue({
      id: "nch_1",
      userId: "user-1",
      kind: "slack",
      label: "Team Slack",
    });
    mocks.sendChannelTestMessage.mockResolvedValue(undefined);

    const result = await testChannel(ctx("nch_1"));

    expect(mocks.sendChannelTestMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "nch_1", kind: "slack" }),
      "org-1",
    );
    expect(mocks.update).toHaveBeenCalledWith("nch_1", { verified: true });
    expect(mocks.touchLastDelivered).toHaveBeenCalledWith("nch_1");
    expect(result).toEqual({ body: { ok: true }, status: 200 });
  });

  test("returns the provider error without marking verified on failure", async () => {
    mocks.findById.mockResolvedValue({
      id: "nch_1",
      userId: "user-1",
      kind: "email",
      label: "On-call email",
    });
    mocks.sendChannelTestMessage.mockRejectedValue(new Error("SMTP unreachable"));

    const result = await testChannel(ctx("nch_1"));

    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toEqual({ body: { ok: false, error: "SMTP unreachable" }, status: 200 });
  });
});

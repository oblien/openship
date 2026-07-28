import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Dispatcher tier-1 (explicit subscriptions) + tier-2 (org-default fallback)
 * fan-out. Tier-2 is the consumer that makes default-enabled categories notify
 * members who never opted in — while respecting an explicit opt-out and never
 * double-firing a channel already covered by tier-1.
 */

const h = vi.hoisted(() => ({
  created: [] as Array<{ userId: string; channelId: string; channelKind: string; category: string }>,
  enabledSubs: [] as Array<{ id: string; userId: string; channelId: string }>,
  channelsById: {} as Record<string, { id: string; kind: string; enabled: boolean; verified: boolean; userId: string } | undefined>,
  defaults: [] as Array<{ category: string; defaultEnabled: boolean; defaultChannelKinds: string[] }>,
  touchedUserIds: [] as string[],
  members: [] as Array<{ userId: string }>,
  verifiedByKinds: [] as Array<{ id: string; kind: string; enabled: boolean; verified: boolean; userId: string }>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    notificationSubscription: {
      listEnabledForDispatch: async () => h.enabledSubs,
      listUserIdsWithSubscription: async () => h.touchedUserIds,
    },
    notificationChannel: {
      findById: async (id: string) => h.channelsById[id],
      listVerifiedForUsersByKinds: async (userIds: string[], kinds: string[]) =>
        h.verifiedByKinds.filter((c) => userIds.includes(c.userId) && kinds.includes(c.kind)),
    },
    notificationDefault: {
      listByOrganization: async () => h.defaults,
    },
    member: {
      listByOrganization: async () => h.members,
    },
    notificationDelivery: {
      create: async (row: { userId: string; channelId: string; channelKind: string; category: string }) => {
        h.created.push({ userId: row.userId, channelId: row.channelId, channelKind: row.channelKind, category: row.category });
        return row;
      },
    },
  },
}));

// Job-trigger side-effect is irrelevant here — stub it so we don't pull the
// job machinery (and its config/env chain) into this unit test.
vi.mock("../../src/modules/jobs/job-events", () => ({ fireJobTriggers: () => {} }));

import { notification } from "../../src/lib/notification-dispatcher";

const ch = (id: string, userId: string, kind: string, over?: Partial<{ enabled: boolean; verified: boolean }>) => ({
  id,
  userId,
  kind,
  enabled: over?.enabled ?? true,
  verified: over?.verified ?? true,
});

beforeEach(() => {
  h.created = [];
  h.enabledSubs = [];
  h.channelsById = {};
  h.defaults = [];
  h.touchedUserIds = [];
  h.members = [];
  h.verifiedByKinds = [];
});

describe("notification dispatcher", () => {
  it("tier-1: delivers to explicitly subscribed verified channels, skips unverified", async () => {
    h.channelsById = {
      c_ok: ch("c_ok", "u1", "email"),
      c_unverified: ch("c_unverified", "u1", "slack", { verified: false }),
    };
    h.enabledSubs = [
      { id: "s1", userId: "u1", channelId: "c_ok" },
      { id: "s2", userId: "u1", channelId: "c_unverified" },
    ];

    await notification.emitSync({ organizationId: "org", eventType: "deployment.failed" });

    expect(h.created.map((d) => d.channelId)).toEqual(["c_ok"]);
    expect(h.created[0].category).toBe("deploy.failed");
  });

  it("tier-2: default-enabled category notifies an untouched member on their default-kind channel", async () => {
    // deploy.failed is default-enabled in the category registry (no org row needed).
    h.members = [{ userId: "u2" }];
    h.touchedUserIds = []; // u2 never touched it
    h.verifiedByKinds = [ch("c_mail", "u2", "email")];

    await notification.emitSync({ organizationId: "org", eventType: "deployment.failed" });

    expect(h.created).toEqual([
      { userId: "u2", channelId: "c_mail", channelKind: "email", category: "deploy.failed" },
    ]);
  });

  it("tier-2 respects an explicit opt-out (a member with any sub row is excluded)", async () => {
    h.members = [{ userId: "u2" }];
    h.touchedUserIds = ["u2"]; // has a (disabled) row → opted out
    h.verifiedByKinds = [ch("c_mail", "u2", "email")];

    await notification.emitSync({ organizationId: "org", eventType: "deployment.failed" });

    expect(h.created).toEqual([]);
  });

  it("does NOT fall back for a default-OFF category with no subscriptions", async () => {
    // deploy.succeeded is default-disabled and has no org override here.
    h.members = [{ userId: "u2" }];
    h.verifiedByKinds = [ch("c_mail", "u2", "email")];

    await notification.emitSync({ organizationId: "org", eventType: "deployment.succeeded" });

    expect(h.created).toEqual([]);
  });

  it("dedupes: a channel covered by tier-1 is not re-delivered by tier-2", async () => {
    h.channelsById = { c_mail: ch("c_mail", "u1", "email") };
    h.enabledSubs = [{ id: "s1", userId: "u1", channelId: "c_mail" }];
    h.members = [{ userId: "u1" }];
    h.touchedUserIds = ["u1"]; // touched → excluded from tier-2 anyway
    h.verifiedByKinds = [ch("c_mail", "u1", "email")];

    await notification.emitSync({ organizationId: "org", eventType: "deployment.failed" });

    expect(h.created).toHaveLength(1);
    expect(h.created[0].channelId).toBe("c_mail");
  });

  it("org default override enables fallback + selects its kinds", async () => {
    // A category that is default-OFF in code, turned ON by an org default with
    // slack as the destination kind.
    h.defaults = [
      { category: "deploy.succeeded", defaultEnabled: true, defaultChannelKinds: ["slack"] },
    ];
    h.members = [{ userId: "u3" }];
    h.verifiedByKinds = [ch("c_slack", "u3", "slack"), ch("c_mail", "u3", "email")];

    await notification.emitSync({ organizationId: "org", eventType: "deployment.succeeded" });

    // Only the slack channel (the org-default kind) is used.
    expect(h.created).toEqual([
      { userId: "u3", channelId: "c_slack", channelKind: "slack", category: "deploy.succeeded" },
    ]);
  });

  it("drops non-notifiable event types", async () => {
    await notification.emitSync({ organizationId: "org", eventType: "some.internal.thing" });
    expect(h.created).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /system/containers/applying` — the fleet's live apply progress.
 *
 * It answers from two stores because neither is the whole truth, and this pins the
 * seam between them:
 *   - the cached rows know every component that was ACCEPTED, including the ones a
 *     bulk run has queued but not started (they have no session yet, and used to be
 *     byte-identical to "never asked for");
 *   - the in-memory sessions know how far the running ones have got and how the
 *     finished ones ended — the only place an outcome exists, since a component that
 *     lands clears its drift and its in-progress mark in the same row write.
 */

vi.mock("@repo/db", () => ({
  repos: {
    server: { listByOrganization: vi.fn() },
    serverContainerStatus: { listByOrg: vi.fn() },
  },
}));
vi.mock("../../../src/lib/controller-helpers", () => ({
  assertNotCloud: vi.fn(() => undefined),
}));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org_1" }),
}));

import { repos } from "@repo/db";
import { listApplyingContainers } from "../../../src/modules/system/server-containers.controller";
import {
  createContainerApplySession,
  finishContainerApplySession,
} from "../../../src/lib/server-container-session";

interface Progress {
  active: {
    serverId: string;
    serverName: string;
    component: string;
    state: "queued" | "running";
    intent: "update" | "repair" | null;
    sessionId?: string;
    steps?: { id: string; status: string }[];
  }[];
  recent: { serverId: string; component: string; ok: boolean; error?: string }[];
}

const mocked = {
  server: vi.mocked(repos.server),
  status: vi.mocked(repos.serverContainerStatus),
};

const row = (over: Record<string, unknown> = {}) => ({
  serverId: "srv_1",
  component: "edge",
  behind: true,
  latestInProgress: true,
  detail: null,
  ...over,
});

async function call(): Promise<Progress> {
  return (await listApplyingContainers({ json: (body: unknown) => body } as never)) as never;
}

/** Unique per case: the session store is module-global. */
let n = 0;
const nextServer = () => `srv_live_${++n}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.server.listByOrganization.mockResolvedValue([
    { id: "srv_1", name: "web-1", sshHost: "10.0.0.1" },
  ] as never);
  mocked.status.listByOrg.mockResolvedValue([] as never);
});

describe("listApplyingContainers", () => {
  it("is empty when nothing is in flight", async () => {
    expect(await call()).toEqual({ active: [], recent: [] });
  });

  it("reports an accepted-but-unstarted target as queued, with no session", async () => {
    mocked.status.listByOrg.mockResolvedValue([row()] as never);

    const { active } = await call();
    expect(active).toMatchObject([
      { serverId: "srv_1", serverName: "web-1", component: "edge", state: "queued", intent: "update" },
    ]);
    expect(active[0]!.sessionId).toBeUndefined();
  });

  it("promotes a target to running once its session exists, and carries its steps", async () => {
    mocked.status.listByOrg.mockResolvedValue([row()] as never);
    const session = createContainerApplySession("srv_1", "edge");
    try {
      const { active } = await call();
      expect(active).toMatchObject([{ state: "running", sessionId: session.id }]);
      expect(active[0]!.steps?.map((s) => s.id)).toEqual(["pull", "recreate", "verify"]);
    } finally {
      finishContainerApplySession(session.id, "completed", { updated: true, down: false });
    }
  });

  it("names the intent from the row — a stopped component is being restarted", async () => {
    mocked.status.listByOrg.mockResolvedValue([
      row({ behind: false, detail: { down: true } }),
    ] as never);

    expect((await call()).active).toMatchObject([{ intent: "repair" }]);
  });

  it("still reports a running swap whose cached row went missing", async () => {
    const id = nextServer();
    mocked.server.listByOrganization.mockResolvedValue([
      { id, name: null, sshHost: "10.0.0.9" },
    ] as never);
    const session = createContainerApplySession(id, "mail");
    try {
      const { active } = await call();
      expect(active).toMatchObject([
        // No row means no recorded intent — the caller falls back to update wording.
        { serverId: id, serverName: "10.0.0.9", component: "mail", state: "running", intent: null },
      ]);
    } finally {
      finishContainerApplySession(session.id, "completed", { updated: true, down: false });
    }
  });

  it("counts a component once when both stores describe it", async () => {
    mocked.status.listByOrg.mockResolvedValue([row()] as never);
    const session = createContainerApplySession("srv_1", "edge");
    try {
      expect((await call()).active).toHaveLength(1);
    } finally {
      finishContainerApplySession(session.id, "completed", { updated: true, down: false });
    }
  });

  it("reports how a just-finished apply ended, success and failure alike", async () => {
    const ok = nextServer();
    const bad = nextServer();
    mocked.server.listByOrganization.mockResolvedValue([
      { id: ok, name: "ok-box", sshHost: "10.0.0.2" },
      { id: bad, name: "bad-box", sshHost: "10.0.0.3" },
    ] as never);
    const good = createContainerApplySession(ok, "edge");
    const failed = createContainerApplySession(bad, "edge");
    finishContainerApplySession(good.id, "completed", { updated: true, down: false });
    finishContainerApplySession(failed.id, "failed", undefined, "could not pull the image");

    const { active, recent } = await call();
    expect(active).toEqual([]);
    expect(recent).toMatchObject([
      { serverId: ok, ok: true },
      { serverId: bad, ok: false, error: "could not pull the image" },
    ]);
  });

  it("never reports a server outside the caller's org", async () => {
    const foreign = nextServer();
    // The org owns a different box entirely, so neither store may surface this run.
    mocked.server.listByOrganization.mockResolvedValue([
      { id: nextServer(), name: "ours", sshHost: "10.0.0.4" },
    ] as never);
    const session = createContainerApplySession(foreign, "edge");
    try {
      expect(await call()).toEqual({ active: [], recent: [] });
    } finally {
      finishContainerApplySession(session.id, "completed", { updated: true, down: false });
    }
  });
});

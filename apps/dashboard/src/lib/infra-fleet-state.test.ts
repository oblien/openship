import { describe, expect, it } from "vitest";

import { summarizeInfraFleet } from "./infra-fleet-state";
import { applyKey } from "./infra-apply-status";
import type { ServerContainerGroup, ServerContainerStatus } from "@/lib/api/system";

function row(over: Partial<ServerContainerStatus> = {}): ServerContainerStatus {
  return {
    id: "scs_1",
    serverId: "srv_1",
    component: "edge",
    runningLabel: "edge:0.4.0",
    pinnedLabel: "edge:0.5.0",
    runningVersion: "0.4.0",
    pinnedVersion: "0.5.0",
    behind: false,
    latestInProgress: false,
    detail: null,
    checkedAt: "2026-08-14T00:00:00.000Z",
    ...over,
  };
}

function group(
  serverId: string,
  components: ServerContainerStatus[],
  projectCount = 1,
): ServerContainerGroup {
  return {
    server: { id: serverId, name: serverId, sshHost: "10.0.0.1", isLocal: false, projectCount },
    components: components.map((c) => ({ ...c, serverId })),
  };
}

describe("summarizeInfraFleet", () => {
  it("has nothing to say about an unread fleet", () => {
    const { summaries, counts } = summarizeInfraFleet(null);
    expect(summaries.size).toBe(0);
    expect(counts).toEqual({
      attention: 0,
      updates: 0,
      healthy: 0,
      stopped: 0,
      behind: 0,
      applying: 0,
    });
  });

  it("counts a behind component as offerable work", () => {
    const { counts, summaries } = summarizeInfraFleet([group("srv_1", [row({ behind: true })])]);
    expect(counts).toMatchObject({ updates: 1, behind: 1, healthy: 0, applying: 0 });
    expect(summaries.get("srv_1")).toMatchObject({ bucket: "updates", updates: 1 });
  });

  it("ranks a down component above an update", () => {
    const { counts, summaries } = summarizeInfraFleet([
      group("srv_1", [row({ detail: { down: true } }), row({ component: "mail", behind: true })]),
    ]);
    expect(counts).toMatchObject({ attention: 1, updates: 0, stopped: 1, behind: 1 });
    expect(summaries.get("srv_1")!.bucket).toBe("attention");
  });

  it("does not offer a gone container as restartable", () => {
    const { counts, summaries } = summarizeInfraFleet([
      group("srv_1", [row({ component: "mail", detail: { down: true, containerMissing: true } })]),
    ]);
    expect(counts).toMatchObject({ attention: 1, stopped: 0 });
    expect(summaries.get("srv_1")).toMatchObject({ missing: ["mail"], down: [] });
  });

  it("treats an absent edge as an issue only where projects are deployed", () => {
    expect(summarizeInfraFleet([group("srv_1", [], 2)]).counts).toMatchObject({ attention: 1 });
    expect(summarizeInfraFleet([group("srv_1", [], 0)]).counts).toMatchObject({
      attention: 0,
      healthy: 1,
    });
  });
});

describe("work already underway", () => {
  it("is never offered again — an in-flight update leaves `behind`", () => {
    const { counts, summaries } = summarizeInfraFleet([
      group("srv_1", [row({ behind: true, latestInProgress: true })]),
    ]);
    expect(counts).toMatchObject({ behind: 0, applying: 1 });
    expect(summaries.get("srv_1")).toMatchObject({ updates: 0, applying: 1 });
  });

  it("is never offered again — an in-flight restart leaves `stopped`", () => {
    const { counts, summaries } = summarizeInfraFleet([
      group("srv_1", [row({ detail: { down: true }, latestInProgress: true })]),
    ]);
    expect(counts).toMatchObject({ stopped: 0, applying: 1 });
    expect(summaries.get("srv_1")!.down).toEqual([]);
  });

  it("keeps the server in the lane it was in, so no result is claimed early", () => {
    // Mid-update → still "has updates", not "healthy".
    expect(
      summarizeInfraFleet([group("srv_1", [row({ behind: true, latestInProgress: true })])]).counts,
    ).toMatchObject({ updates: 1, healthy: 0 });
    // Mid-restart → still "needs attention": it is stopped until the restart lands.
    expect(
      summarizeInfraFleet([
        group("srv_1", [row({ detail: { down: true }, latestInProgress: true })]),
      ]).counts,
    ).toMatchObject({ attention: 1, healthy: 0 });
  });

  it("counts a run the progress read knows about but the row does not", () => {
    // A cached row dropped mid-swap (or a flag that hasn't been re-read yet) must not
    // read as idle while the API is plainly still applying it.
    const live = new Set([applyKey("srv_1", "edge")]);
    const { counts, summaries } = summarizeInfraFleet(
      [group("srv_1", [row({ behind: true })])],
      live,
    );
    expect(counts).toMatchObject({ behind: 0, applying: 1 });
    expect(summaries.get("srv_1")!.applying).toBe(1);
  });

  it("still offers the components that are NOT underway", () => {
    const { counts } = summarizeInfraFleet([
      group("srv_1", [row({ behind: true, latestInProgress: true })]),
      group("srv_2", [row({ behind: true })]),
    ]);
    expect(counts).toMatchObject({ updates: 2, behind: 1, applying: 1 });
  });

  it("leaves a healthy fleet clean once the work lands", () => {
    const { counts } = summarizeInfraFleet([
      group("srv_1", [row(), row({ component: "mail" })]),
      group("srv_2", [row()]),
    ]);
    expect(counts).toMatchObject({ attention: 0, updates: 0, healthy: 2, applying: 0 });
  });
});

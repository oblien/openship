import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "https://controller.example.test",
  getToken: () => "opsh_pat_fixture",
}));

import { githubCommand } from "../../src/commands/github";
import { settingsCommand } from "../../src/commands/settings";
import { analyticsCommand } from "../../src/commands/analytics";
import { networkCommand, clusterCommand } from "../../src/commands/server-infrastructure";
import { containerCommand } from "../../src/commands/server-integrations";
import {
  projectClusterCommand,
  projectDatabaseCommand,
  projectVolumeCommand,
} from "../../src/commands/project-data";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
let directory: string;
function inputFile(value: unknown) {
  const path = join(directory, "input.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openship-platform-cli-"));
  setJsonMode(true);
});
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
  rmSync(directory, { recursive: true, force: true });
});

describe("first-class platform workflows", () => {
  it("preserves GitHub device instructions and polls the same selected controller", async () => {
    fetchStub = stubFetch((request) => ({
      json:
        request.method === "POST"
          ? {
              connected: false,
              flow: "device_code",
              userCode: "ABCD-1234",
              verificationUri: "https://github.com/login/device",
              expiresIn: 900,
              interval: 5,
            }
          : { status: "waiting" },
    }));
    const started = await runCommand(githubCommand, ["connect", "--source", "cli"]);
    expect(started.code, started.err).toBe(0);
    expect(JSON.parse(started.out)).toMatchObject({
      connected: false,
      flow: "device_code",
      userCode: "ABCD-1234",
    });
    const pending = await runCommand(githubCommand, ["poll", "--state", "attempt-fixture"]);
    expect(pending.code, pending.err).toBe(0);
    expect(JSON.parse(pending.out)).toEqual({ status: "waiting" });
    expect(fetchStub.calls).toHaveLength(2);
    expect(fetchStub.calls[1].url).toBe(
      "https://controller.example.test/api/github/connect/poll?state=attempt-fixture",
    );
    expect(
      fetchStub.calls.every((call) => call.headers.authorization === "Bearer opsh_pat_fixture"),
    ).toBe(true);
  });

  it("keeps repository branch pagination explicit rather than silently truncating it", async () => {
    const page = {
      data: [
        {
          name: "feature/release",
          commit: { sha: "a".repeat(40), url: "https://github.com/team/repo/commit/a" },
          protected: false,
        },
      ],
      pagination: { page: 2, perPage: 100, hasMore: true },
    };
    fetchStub = stubFetch(() => ({ json: page }));
    const result = await runCommand(githubCommand, [
      "repo",
      "branches",
      "team/repo",
      "--page",
      "2",
    ]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual(page);
    expect(new URL(fetchStub.calls[0].url).searchParams.get("page")).toBe("2");
  });

  it("rejects a malformed repository before contacting either provider", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Unexpected request");
    });
    const result = await runCommand(githubCommand, ["repo", "get", "team/repo/extra"]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("does not delete a GitHub repository without confirmation", async () => {
    fetchStub = stubFetch(() => ({ json: { success: true } }));
    expect((await runCommand(githubCommand, ["repo", "remove", "team/repo"])).code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    const result = await runCommand(githubCommand, ["repo", "remove", "team/repo", "--yes"]);
    expect(result.code, result.err).toBe(0);
    expect(fetchStub.calls[0]).toMatchObject({
      method: "DELETE",
      url: "https://controller.example.test/api/github/repos/team/repo",
    });
  });

  it("reads a GitHub credential from a file and does not echo the secret", async () => {
    const secret = "github_pat_TEST_SECRET";
    const path = join(directory, "token");
    writeFileSync(path, `${secret}\n`, { mode: 0o600 });
    fetchStub = stubFetch(() => ({ json: { connected: true, login: "fixture" } }));
    const result = await runCommand(githubCommand, ["token", path]);
    expect(result.code, result.err).toBe(0);
    expect(fetchStub.calls[0].body).toEqual({ token: secret });
    expect(result.out + result.err).not.toContain(secret);
  });

  it("allows offline discovery of advanced input contracts without provisioning", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Schema discovery must be offline");
    });
    const result = await runCommand(clusterCommand, ["storage", "setup", "--schema"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).required).toContain("requestId");
    expect(JSON.parse(result.out).properties.config.properties.disks.minItems).toBe(2);
    expect(fetchStub.calls).toEqual([]);
  });

  it("validates storage configuration before asking the controller to install anything", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Invalid setup must not be dispatched");
    });
    const path = inputFile({
      clusterId: "cluster-fixture",
      requestId: "setup-fixture-0001",
      config: { replicas: 1, disks: [] },
    });
    expect((await runCommand(clusterCommand, ["storage", "setup", path, "--yes"])).code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("never refreshes or replaces a stale reviewed network plan while applying it", async () => {
    fetchStub = stubFetch(() => ({
      status: 409,
      json: { code: "PLAN_CHANGED", error: "Review the new network plan" },
    }));
    const hash = "a".repeat(64);
    const result = await runCommand(networkCommand, [
      "operation",
      "apply",
      "operation-fixture",
      "--plan-hash",
      hash,
      "--action",
      "resume",
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Review the new network plan");
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].body).toEqual({ planHash: hash, action: "resume" });
    expect(fetchStub.calls[0].url).toContain("/networks/operations/operation-fixture/apply");
  });

  it("reattaches to a container update without starting a duplicate and fails on an SSE error", async () => {
    fetchStub = stubFetch(() => ({
      headers: { "Content-Type": "text/event-stream" },
      text: 'event: log\ndata: {"message":"Verifying"}\n\nevent: error\ndata: {"error":"Verification failed"}\n\n',
    }));
    const result = await runCommand(containerCommand, ["events", "server-fixture", "edge"]);
    expect(result.code).toBe(1);
    expect(
      result.out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { event: "log", data: { message: "Verifying" } },
      { event: "error", data: { error: "Verification failed" } },
    ]);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]).toMatchObject({
      method: "GET",
      url: "https://controller.example.test/api/system/servers/server-fixture/containers/edge/apply/stream",
    });
  });

  it("scales only the explicitly reviewed project deployment and timestamp", async () => {
    fetchStub = stubFetch(() => ({ json: { data: { deploymentId: "deploy-scaled" } } }));
    const result = await runCommand(projectClusterCommand, [
      "scale",
      "project-fixture",
      "3",
      "--deployment",
      "deploy-original",
      "--updated-at",
      "2026-10-07T00:00:00.000Z",
    ]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ deploymentId: "deploy-scaled" });
    expect(fetchStub.calls[0].body).toEqual({
      replicas: 3,
      expectedDeploymentId: "deploy-original",
      expectedUpdatedAt: "2026-10-07T00:00:00.000Z",
    });
  });

  it.each([
    ['event: complete\ndata: {"status":"failed","error":"unhealthy"}\n\n', 1],
    ['event: log\ndata: {"message":"Restarting"}\n\n', 1],
    ['event: complete\ndata: {"status":"completed"}\n\n', 0],
  ])("requires confirmed completion of a container update (%s)", async (text, code) => {
    fetchStub = stubFetch(() => ({ headers: { "Content-Type": "text/event-stream" }, text }));
    const result = await runCommand(containerCommand, ["apply", "server-fixture", "edge", "--yes"]);
    expect(result.code).toBe(code);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].method).toBe("POST");
  });

  it("keeps database removal explicit about sequence and data retention", async () => {
    const payload = {
      databaseId: "database-fixture",
      expectedSequence: 4,
      name: "production",
      deleteData: false,
    };
    const path = inputFile(payload);
    fetchStub = stubFetch(() => ({ status: 403, json: { error: "Project write required" } }));
    expect(
      (await runCommand(projectDatabaseCommand, ["remove", "project-fixture", path])).code,
    ).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    const result = await runCommand(projectDatabaseCommand, [
      "remove",
      "project-fixture",
      path,
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].body).toEqual(payload);
  });

  it("requires explicit data deletion for volume removal before any API call", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Must validate deletion acknowledgement");
    });
    const path = inputFile({ name: "data", confirmName: "data", resourceVersion: "17" });
    expect(
      (await runCommand(projectVolumeCommand, ["remove", "project-fixture", path, "--yes"])).code,
    ).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("rejects unsupported user preference values before writing them", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Invalid preference");
    });
    expect((await runCommand(settingsCommand, ["build-mode", "unknown"])).code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("distinguishes an unavailable runtime measurement from zero usage", async () => {
    fetchStub = stubFetch(() => ({ json: { data: null } }));
    const result = await runCommand(analyticsCommand, ["usage", "project-fixture"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toBeNull();
  });
});

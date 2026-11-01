import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "token" }));
import { serviceCommand } from "../../src/commands/service";
import { projectCommand } from "../../src/commands/project";
import { monitoringCommand } from "../../src/commands/monitoring";
import { notificationCommand } from "../../src/commands/notification";
import { credentialCommand } from "../../src/commands/credential";
import { webhookCommand } from "../../src/commands/webhook";
import { accessCommand } from "../../src/commands/access";
import { domainCommand } from "../../src/commands/domain";
import { credentialFixture, serviceFixture, domainDnsChallengeFixture } from "../../../../packages/contracts/test/fixtures";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { setJsonMode } from "../../src/lib/output";

let fetchStub: FetchStub;
const directories: string[] = [];
afterEach(async () => {
  fetchStub?.restore(); setJsonMode(false);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function file(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "openship-management-")); directories.push(directory);
  const path = join(directory, "input.json"); await writeFile(path, JSON.stringify(value)); return path;
}

describe("management commands keep validation and authority in the SDK", () => {
  it("rejects unknown service fields before resolution or mutation", async () => {
    const input = await file({ projectId: "another-tenant", image: "nginx:alpine" });
    fetchStub = stubFetch(() => { throw new Error("Invalid patch must not reach the server"); });
    const result = await runCommand(serviceCommand, ["update", "svc_a", input, "--project", "proj_a"]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("returns effective environment state without silently inspecting or revealing runtime secrets", async () => {
    const state = { environment: "production", variables: [{ key: "TOKEN", value: "••••••••", isSecret: true, source: "compose" }], missingRequired: [], status: "unchecked", changedKeys: [], recoverableKeys: [] };
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { service: serviceFixture("svc_a", "proj_a") } };
      expect(new URL(req.url).searchParams.get("inspectRuntime")).toBe("false");
      return { json: { environment: state } };
    });
    const result = await runCommand(serviceCommand, ["env", "inspect", "svc_a", "-p", "proj_a"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(state);
    expect(fetchStub.calls.every(req => req.method === "GET")).toBe(true);
  });

  it("creates a separate preview project and does not start a deployment implicitly", async () => {
    const preview = { id: "proj_preview", name: "Preview", slug: "preview", type: "preview", gitBranch: "feature", projectSlug: "app-preview", latestDeploymentStatus: null, version: null, isApp: false, gitProvider: "github" };
    fetchStub = stubFetch(req => {
      expect(req.url).toBe("http://api.test/api/projects/proj_a/environments");
      expect(req.body).toMatchObject({ environmentName: "Preview", environmentType: "preview", gitBranch: "feature" });
      return { json: { data: preview } };
    });
    const result = await runCommand(projectCommand, ["environment", "create", "proj_a", "Preview", "--branch", "feature"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(preview);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("surfaces Cloud resource capacity rejection without falling back to local limits", async () => {
    const patch = await file({ production: { cpuCores: 100, memoryMb: 1024 } });
    fetchStub = stubFetch(req => {
      expect(req.body).toEqual({ production: { cpuCores: 100, memoryMb: 1024 } });
      return { status: 400, json: { code: "RESOURCE_LIMIT", error: "Exceeds destination capacity" } };
    });
    const result = await runCommand(projectCommand, ["resources", "set", "proj_a", patch]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("capacity");
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("does not manage a watcher when the connection lacks that capability", async () => {
    fetchStub = stubFetch(() => ({ json: { data: [], watching: false,
      capabilities: { current: true, continuous: false }, currentScan: null,
      watcher: { key: "server-controlled-key", schedule: null, available: false, eventsEnabled: false, canManage: false, runsWhileAppOpen: false },
    } }));
    const result = await runCommand(monitoringCommand, ["watch", "enable"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot manage continuous monitoring");
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].method).toBe("GET");
  });

  it("reports failed notification delivery with JSON and a failing exit status", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ status: 400, json: { ok: false, error: "Provider unavailable" } }));
    const result = await runCommand(notificationCommand, ["channel", "test", "channel-a"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ ok: false, error: "Provider unavailable" });
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("treats an invalid credential as a failed verification, preserving masked output", async () => {
    fetchStub = stubFetch(() => ({ json: { data: { ...credentialFixture(), status: "invalid", lastError: "Rejected" } } }));
    const result = await runCommand(credentialCommand, ["verify", "credential-a"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ status: "invalid", secretsMasked: { secret: "••••••••" } });
  });

  it("does not rotate a webhook credential without confirmation in JSON mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => { throw new Error("Must not rotate"); });
    const result = await runCommand(webhookCommand, ["rotate", "hook-a", "--project", "proj_a"]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("passes authorization failures through without replacing permissions or retrying", async () => {
    const patch = await file({ userId: "user-a", resourceType: "project", resourceId: "proj_a", permissions: ["read"] });
    fetchStub = stubFetch(() => ({ status: 403, json: { code: "FORBIDDEN", error: "Cannot grant access to this resource" } }));
    const result = await runCommand(accessCommand, ["grants", "set", patch]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Cannot grant access");
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("checks only the requested DNS challenge attempt", async () => {
    const challenge = domainDnsChallengeFixture();
    fetchStub = stubFetch(req => {
      expect(req.body).toEqual({ attemptId: challenge.id });
      return { json: { data: challenge } };
    });
    const result = await runCommand(domainCommand, ["dns", "challenge", "check", "domain-a", "--attempt", challenge.id]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(challenge);
    expect(fetchStub.calls).toHaveLength(1);
  });
});

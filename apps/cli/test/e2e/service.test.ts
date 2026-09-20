import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "token" }));
import { serviceCommand } from "../../src/commands/service";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { serviceFixture } from "../../../../packages/contracts/test/fixtures";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());
const service = serviceFixture("svc_a", "proj_a");

describe("service commands through the SDK", () => {
  it("uses direct IDs without requiring project or service collection access", async () => {
    fetchStub = stubFetch(req => {
      expect(req.url).toBe("http://api.test/api/projects/proj_a/services/svc_a");
      return { json: { success: true, service } };
    });
    const result = await runCommand(serviceCommand, ["get", "svc_a", "-p", "proj_a"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("svc_a");
  });
  it("preserves unrevealed environment secrets while setting another key", async () => {
    const updated: unknown[] = [];
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      if (req.method === "GET") return { json: { success: true, vars: [{ id: "env_secret", key: "TOKEN", value: "••••••••", isSecret: true, environment: "production", createdAt: "2026-09-12", updatedAt: "2026-09-12" }] } };
      expect(req.method).toBe("PUT");
      expect(req.body).toMatchObject({ environment: "production", vars: [{ sourceId: "env_secret", key: "TOKEN", value: "••••••••", isSecret: true }, { key: "MODE", value: "ready", isSecret: false }] });
      updated.push(req.body);
      return { json: { success: true, count: 2 } };
    });
    const result = await runCommand(serviceCommand, ["env", "set", "svc_a", "MODE=ready", "-p", "proj_a"]);
    expect(result.code).toBe(0);
    expect(updated).toHaveLength(1);
  });
  it("runs bounded exec and returns the process exit status", async () => {
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      expect(req.url).toBe("http://api.test/api/projects/proj_a/services/svc_a/exec");
      expect(req.body).toEqual({ command: "exit 7", timeoutMs: 30000 });
      return { json: { data: { exitCode: 7, output: "command result", truncated: false, timedOut: false, durationMs: 2 } } };
    });
    const result = await runCommand(serviceCommand, ["exec", "svc_a", "exit 7", "-p", "proj_a"]);
    expect(result.code).toBe(7);
    expect(result.out).toContain("command result");
  });
  it("reports pending environment keys when a restart is refused", async () => {
    fetchStub = stubFetch(req => req.url.endsWith("/services/svc_a") ? { json: { success: true, service } } : {
      status: 409, json: { error: "Config changed", code: "SERVICE_CONFIG_STALE", staleEnvKeys: ["TOKEN"], serviceName: "web" },
    });
    const result = await runCommand(serviceCommand, ["restart", "svc_a", "-p", "proj_a"]);
    expect(result.code).toBe(1);
    expect(result.out + result.err).toContain("TOKEN");
    expect(result.out + result.err).toContain("--refresh --service-ids svc_a");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "token" }));
import { serviceCommand } from "../../src/commands/service";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { serviceFixture } from "../../../../packages/contracts/test/fixtures";
import { setJsonMode } from "../../src/lib/output";

let fetchStub: FetchStub;
afterEach(() => { fetchStub?.restore(); setJsonMode(false); });
const service = serviceFixture("svc_a", "proj_a");
const secret = { id: "env_secret", key: "TOKEN", value: "••••••••", isSecret: true, environment: "production", createdAt: "2026-09-12", updatedAt: "2026-09-12" };

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
    setJsonMode(true);
    const variables = new Map([["TOKEN", "untouched-secret"]]);
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      if (req.method === "GET") {
        // Another client adds a variable after the CLI's read snapshot.
        variables.set("CONCURRENT", "keep-me");
        return { json: { success: true, vars: [secret] } };
      }
      expect(req.method).toBe("PATCH");
      expect(req.body).toEqual({ environment: "production", upserts: [{ key: "MODE", value: "ready", sourceId: null }], deletes: [] });
      for (const row of (req.body as { upserts: { key: string; value: string }[] }).upserts) variables.set(row.key, row.value);
      return { json: { success: true } };
    });
    const result = await runCommand(serviceCommand, ["env", "set", "svc_a", "MODE=ready", "-p", "proj_a"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ success: true });
    expect(Object.fromEntries(variables)).toEqual({ TOKEN: "untouched-secret", CONCURRENT: "keep-me", MODE: "ready" });
    expect(result.out).not.toContain("untouched-secret");
  });

  it("updates only the selected existing override and retains engine secret classification", async () => {
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      if (req.method === "GET") return { json: { success: true, vars: [secret] } };
      expect(req.method).toBe("PATCH");
      expect(req.body).toEqual({ environment: "production", upserts: [{ key: "TOKEN", value: "replacement=a", sourceId: "env_secret" }], deletes: [] });
      return { json: { success: true } };
    });
    expect((await runCommand(serviceCommand, ["env", "set", "svc_a", "TOKEN=replacement=a", "-p", "proj_a"])).code).toBe(0);
  });

  it("surfaces a stale override rejection without retrying as a replacement", async () => {
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      if (req.method === "GET") return { json: { success: true, vars: [secret] } };
      return { status: 409, json: { code: "ENVIRONMENT_CHANGED", error: "Environment changed; reload before saving." } };
    });
    const result = await runCommand(serviceCommand, ["env", "set", "svc_a", "TOKEN=new", "-p", "proj_a"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("reload");
    expect(fetchStub.calls.map(req => req.method)).toEqual(["GET", "GET", "PATCH"]);
  });

  it("performs a full replacement only with explicit --replace", async () => {
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      expect(req.method).toBe("PUT");
      expect(req.body).toEqual({ environment: "production", vars: [{ key: "MODE", value: "", isSecret: true }] });
      return { json: { success: true, count: 1 } };
    });
    expect((await runCommand(serviceCommand, ["env", "set", "svc_a", "MODE=", "--replace", "--secret", "-p", "proj_a"])).code).toBe(0);
    expect(fetchStub.calls).toHaveLength(2);
  });

  it("deletes only the selected overrides using their source IDs", async () => {
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      if (req.method === "GET") return { json: { success: true, vars: [secret] } };
      expect(req.body).toEqual({ environment: "production", upserts: [], deletes: [{ key: "TOKEN", sourceId: "env_secret" }] });
      return { json: { success: true } };
    });
    expect((await runCommand(serviceCommand, ["env", "delete", "svc_a", "TOKEN", "MISSING", "-p", "proj_a"])).code).toBe(0);
  });

  it("uses the shared apply workflow and returns its container and warning", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      expect(req.url).toBe("http://api.test/api/projects/proj_a/services/svc_a/apply-env");
      expect(req.method).toBe("POST");
      return { json: { success: true, containerId: "replacement", warning: "Check application startup" } };
    });
    const result = await runCommand(serviceCommand, ["env", "apply", "svc_a", "-p", "proj_a"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ containerId: "replacement", warning: "Check application startup" });
  });

  it("propagates failed apply and rollback information instead of claiming success", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(req => req.url.endsWith("/services/svc_a") ? { json: { success: true, service } } : {
      status: 409, json: { code: "SERVICE_ENV_APPLY_FAILED", error: "Previous service configuration preserved" },
    });
    const result = await runCommand(serviceCommand, ["env", "apply", "svc_a", "-p", "proj_a"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("preserved");
    expect(result.out).toBe("");
  });

  it("reveals only named keys with the expected runtime container", async () => {
    fetchStub = stubFetch(req => {
      if (req.url.endsWith("/services/svc_a")) return { json: { success: true, service } };
      expect(req.url).toContain("/env-reveal");
      expect(req.body).toEqual({ keys: ["TOKEN"], source: "runtime", containerId: "current" });
      return { json: { environment: { TOKEN: "explicitly-revealed" } } };
    });
    const result = await runCommand(serviceCommand, ["env", "reveal", "svc_a", "TOKEN", "--source", "runtime", "--container", "current", "-p", "proj_a"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ TOKEN: "explicitly-revealed" });
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
    expect(result.out + result.err).toContain("service env apply svc_a --project proj_a");
  });
});

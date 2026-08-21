import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { deploymentCommand } from "../../src/commands/deployment";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship deployment list", () => {
  it("scopes the query by project and environment, and renders the rows", async () => {
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          {
            id: "dep1",
            status: "ready",
            environment: "production",
            branch: "main",
            commitSha: "abcdef1234567890",
            isActive: true,
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
      },
    }));
    const { out, code } = await runCommand(deploymentCommand, [
      "list",
      "--project",
      "p1",
      "--env",
      "production",
      "--limit",
      "10",
    ]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe(
      "http://api.test/api/deployments?projectId=p1&environment=production&perPage=10",
    );
    expect(out).toContain("dep1");
    expect(out).toContain("abcdef1"); // commit column is the short sha
  });

  it("clamps --limit to the API's 100-row ceiling", async () => {
    fetchStub = stubFetch(() => ({ json: { data: [] } }));
    const { code } = await runCommand(deploymentCommand, [
      "list",
      "--project",
      "p1",
      "--limit",
      "500",
    ]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toContain("perPage=100");
  });
});

describe("openship deployment get", () => {
  it("GETs /deployments/:id and renders it", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: { id: "dep1", status: "success", env: "production" } },
    }));
    const { out, code } = await runCommand(deploymentCommand, ["get", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1");
    expect(out).toContain("dep1");
    expect(out).toContain("success");
  });
});

describe("openship deployment redeploy", () => {
  it("POSTs to /deployments/:id/redeploy", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep2" } }));
    const { code } = await runCommand(deploymentCommand, ["redeploy", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1/redeploy");
  });
});

describe("openship deployment rollback", () => {
  it("POSTs to /deployments/:id/rollback", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
    const { code } = await runCommand(deploymentCommand, ["rollback", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1/rollback");
  });
});

// The interactive good/bad/skip loop and the final rollback prompt both read
// real stdin (@clack/prompts `select`, the local readline `confirm`) once a
// TTY is present — there's no mock seam for either in this harness (no other
// command's tests exercise that path either), so only the deterministic
// branches below are covered here. The binary-search math itself is fully
// unit-tested in test/unit/bisect.test.ts.
describe("openship deployment bisect", () => {
  const realIsTTY = process.stdin.isTTY;
  afterEach(() => {
    (process.stdin as { isTTY?: boolean }).isTTY = realIsTTY;
  });

  it("refuses to run without a TTY — bisect needs a human to judge each candidate", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("interactive");
  });

  it("errors when nothing in range is testable", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          { id: "dep1", status: "building", branch: "main", createdAt: "2024-01-01T00:00:00Z" },
        ],
      },
    }));
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("Need at least two testable deployments");
  });

  it("errors on a single testable deployment without blaming flags the user never passed", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          { id: "dep-only", status: "ready", branch: "main", createdAt: "2024-01-01T00:00:00Z" },
        ],
      },
    }));
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("Need at least two testable deployments");
    expect(errOut).not.toContain("--good");
  });

  it("errors when --good isn't among the fetched deployments", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          { id: "dep-old", status: "ready", branch: "main", createdAt: "2024-01-01T00:00:00Z" },
          { id: "dep-new", status: "ready", branch: "main", createdAt: "2024-01-02T00:00:00Z" },
        ],
      },
    }));
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
      "--good",
      "dep-missing",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("dep-missing");
    expect(errOut).toContain("not found");
  });

  it("errors when --bad isn't among the fetched deployments", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          { id: "dep-old", status: "ready", branch: "main", createdAt: "2024-01-01T00:00:00Z" },
          { id: "dep-new", status: "ready", branch: "main", createdAt: "2024-01-02T00:00:00Z" },
        ],
      },
    }));
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
      "--bad",
      "dep-missing",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("dep-missing");
    expect(errOut).toContain("not found");
  });

  it("errors when --good is chronologically at or after --bad", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          { id: "dep-old", status: "ready", branch: "main", createdAt: "2024-01-01T00:00:00Z" },
          { id: "dep-new", status: "ready", branch: "main", createdAt: "2024-01-02T00:00:00Z" },
        ],
      },
    }));
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
      "--good",
      "dep-new",
      "--bad",
      "dep-old",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("chronologically before");
  });

  it("excludes queued/building/failed deployments from the testable set", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          { id: "dep-queued", status: "queued", branch: "main", createdAt: "2024-01-01T00:00:00Z" },
          { id: "dep-failed", status: "failed", branch: "main", createdAt: "2024-01-02T00:00:00Z" },
        ],
      },
    }));
    const { err: errOut, code } = await runCommand(deploymentCommand, [
      "bisect",
      "--project",
      "p1",
      "--env",
      "production",
    ]);
    expect(code).toBe(1);
    expect(errOut).toContain("found 0");
    // bisect scopes its fetch exactly like `deployment list` does.
    expect(fetchStub.calls[0].url).toBe(
      "http://api.test/api/deployments?projectId=p1&environment=production&perPage=50",
    );
  });
});

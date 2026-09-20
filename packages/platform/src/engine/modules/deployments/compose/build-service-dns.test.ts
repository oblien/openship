import {
  BuildLogger,
  DEFAULT_RESOURCE_CONFIG,
  type BuildResult,
  type LogEntry,
} from "@repo/adapters";
import { describe, expect, it, vi } from "vitest";

const { listByProject, broadcastServiceStatus } = vi.hoisted(() => ({
  listByProject: vi.fn(),
  broadcastServiceStatus: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { service: { listByProject } } }));
vi.mock("../session-manager", () => ({
  broadcastServiceStatus,
  broadcastInstallPhase: vi.fn(),
}));

import { buildComposeImages } from "./build.service";
import { ServiceBuildDnsDiagnostics } from "./build-service-dns";

const DOCKER_FAILURE =
  "Docker build failed: The command '/bin/sh -c pnpm --filter @zervo/admin build' returned a non-zero code: 1";

async function buildWithLogs(
  options: {
    messages?: string[];
    adminResult?: Partial<BuildResult>;
    runtimeName?: "docker" | "cloud";
  } = {},
) {
  broadcastServiceStatus.mockClear();
  const services = [
    { id: "db", name: "db", enabled: true, image: "postgres:17-alpine", build: null },
    ...["admin", "worker"].map((name) => ({
      id: name,
      name,
      enabled: true,
      image: null,
      kind: "compose",
      build: ".",
      dockerfile: "Dockerfile",
    })),
  ];
  listByProject.mockResolvedValue(services);
  const entries: LogEntry[] = [];
  const result = await buildComposeImages({
    project: { id: "project", slug: "example", name: "example", localPath: null } as never,
    dep: { id: "deployment", branch: "main", trigger: "deploy", meta: null } as never,
    snapshot: {
      repoUrl: "https://example.com/repo.git",
      branch: "main",
      framework: "docker",
      buildImage: "",
      runtimeImage: "",
      packageManager: "",
      installCommand: "",
      buildCommand: "",
      outputDirectory: "",
      productionPaths: [],
      rootDirectory: "",
      port: 3000,
      startCommand: "",
      hasServer: true,
      hasBuild: false,
    } as never,
    runtime: {
      name: options.runtimeName ?? "docker",
      build: vi.fn(),
      buildImages: async (
        items: Array<{
          serviceName: string;
          logger: BuildLogger;
          onResult: (result: BuildResult) => void;
        }>,
      ) => {
        for (const item of items) {
          if (item.serviceName === "admin") {
            for (const message of options.messages ?? []) {
              item.logger.observeBuildOutput(message);
              item.logger.log(message.trim());
            }
          }
          item.onResult({
            sessionId: "build",
            status: "failed",
            errorMessage: DOCKER_FAILURE,
            ...(item.serviceName === "admin" ? options.adminResult : {}),
          });
        }
      },
    } as never,
    logger: new BuildLogger((entry) => entries.push(entry)),
    buildSessionId: "build",
    composeInterpolationEnv: {},
    buildEnvVars: {},
    buildResources: DEFAULT_RESOURCE_CONFIG,
  });
  return { result, entries };
}

describe("service DNS failures during Docker builds", () => {
  it("adds actionable guidance to the failed service without losing the Docker error", async () => {
    const { result, entries } = await buildWithLogs({
      messages: [
        "[21:53:30] ERROR: Error: cannot connect to Postgres. Details: getaddrinfo ENOTFOUND db\n",
        "Error: Failed to collect page data for /api/hours\n",
      ],
    });

    const failure = result.buildFailures.get("admin")!;
    expect(failure).toContain("getaddrinfo ENOTFOUND db");
    expect(failure).toContain("dependsOn");
    expect(failure).toContain("request handler");
    expect(failure).toContain(DOCKER_FAILURE);
    expect(failure.startsWith(DOCKER_FAILURE)).toBe(true);
    expect(result.buildFailures.get("worker")).toBe(DOCKER_FAILURE);
    expect(
      entries.some((entry) => entry.serviceName === "admin" && entry.message.includes(failure)),
    ).toBe(true);
    expect(broadcastServiceStatus).toHaveBeenCalledWith("deployment", {
      serviceName: "admin",
      serviceId: "admin",
      status: "failed",
      error: failure,
    });
  });

  it.each([
    "getaddrinfo ENOTFOUND registry.npmjs.org",
    "getaddrinfo ENOTFOUND db.example.com",
    "connect ETIMEDOUT 172.18.0.2:5432",
    "getaddrinfo ENOTFOUND db:5432",
    "password authentication failed for user demo",
  ])("does not attribute an unrelated failure to the service network: %s", async (message) => {
    const { result } = await buildWithLogs({ messages: [message] });
    expect(result.buildFailures.get("admin")).toBe(DOCKER_FAILURE);
  });

  it("copies only the known service name into guidance, never adjacent credentials", async () => {
    const { result } = await buildWithLogs({
      messages: [
        "Connecting to postgres://demo:do-not-repeat@db:5432/app?token=private-token\nError: getaddrinfo ENOTFOUND db",
      ],
    });
    const failure = result.buildFailures.get("admin")!;
    expect(failure).toContain("getaddrinfo ENOTFOUND db");
    expect(failure).not.toContain("do-not-repeat");
    expect(failure).not.toContain("private-token");
    expect(failure).not.toContain("postgres://");
  });

  it.each(["deploying", "cancelled"] as const)(
    "does not turn a %s build into a failure after an earlier DNS error",
    async (status) => {
      const { result, entries } = await buildWithLogs({
        messages: ["getaddrinfo ENOTFOUND db"],
        adminResult: { status, imageRef: "openship/example-admin:built" },
      });
      expect(result.buildFailures.has("admin")).toBe(false);
      expect(entries.some((entry) => entry.message.includes("dependsOn"))).toBe(false);
      if (status === "deploying") {
        expect(result.imageRefs.get("admin")).toBe("openship/example-admin:built");
      } else {
        expect(result.cancelled).toBe(true);
      }
    },
  );

  it("also recognizes DNS evidence in the final error when no log was streamed", async () => {
    const errorMessage = "Docker build failed: getaddrinfo ENOTFOUND db";
    const { result } = await buildWithLogs({ adminResult: { errorMessage } });
    const failure = result.buildFailures.get("admin")!;
    expect(failure).toContain(errorMessage);
    expect(failure).toContain("dependsOn");
  });

  it("does not assume Docker networking for a cloud build", async () => {
    const { result } = await buildWithLogs({
      runtimeName: "cloud",
      messages: ["getaddrinfo ENOTFOUND db"],
    });
    expect(result.buildFailures.get("admin")).toBe(DOCKER_FAILURE);
  });

  it.each([
    { label: "split error marker", messages: ["getaddrinfo ENO", "TFOUND db\n"] },
    { label: "split hostname", messages: ["getaddrinfo ENOTFOUND d", "b\n"] },
    { label: "unterminated final line", messages: ["getaddrinfo ENOTFOUND db"] },
    { label: "colored error", messages: ["getaddrinfo \u001b[31mENOTFOUND\u001b[0m db\n"] },
    {
      label: "split color sequence",
      messages: ["getaddrinfo \u001b[3", "1mENOTFOUND\u001b[0m db\n"],
    },
  ])("recognizes streamed output with a $label", async ({ messages }) => {
    const { result } = await buildWithLogs({ messages });
    expect(result.buildFailures.get("admin")).toContain("dependsOn");
  });

  it("waits for the whole hostname before identifying a project service", async () => {
    const { result } = await buildWithLogs({
      messages: ["getaddrinfo ENOTFOUND db", ".example.com\n"],
    });
    expect(result.buildFailures.get("admin")).toBe(DOCKER_FAILURE);
  });

  it("does not join fragments from different output streams or BuildKit steps", () => {
    const diagnostics = new ServiceBuildDnsDiagnostics(new Set(["db"]));
    diagnostics.observe("getaddrinfo ENOTFOUND d", "stdout");
    diagnostics.observe("b\n", "stderr");
    expect(diagnostics.finish(DOCKER_FAILURE)).toBeUndefined();
  });
});

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { CommandExecutor, LogEntry } from "@repo/adapters";

/**
 * `serverLogStream` relays the EDGE's SSE frames to the browser. The frames are
 * the edge's, so the relay must be byte-exact: `pipe_stream.lua` emits UTF-8, and
 * both transports hand the controller arbitrary byte slices of it, so a chunk
 * boundary can land in the MIDDLE of a multi-byte character.
 *
 * These drive the exec transport (`execMgmtStream` → `streamChunkBytes` → the
 * controller) through a real Hono SSE stream and compare the bytes the client
 * receives with the bytes the edge emitted.
 */

const h = vi.hoisted(() => ({
  executor: null as CommandExecutor | null,
}));

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ userId: "user_1", organizationId: "org_1" }),
}));

vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn(async () => {}) },
}));

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    retain: vi.fn(),
    release: vi.fn(),
    acquire: vi.fn(async () => h.executor),
  },
}));

vi.mock("@/lib/openresty-paths", () => ({
  getOpenRestyPaths: vi.fn(async () => ({})),
}));

vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return { ...actual, deployLuaScripts: vi.fn(async () => {}) };
});

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById: vi.fn(async (id: string) => ({ id, organizationId: "org_1" })),
      },
    },
  };
});

vi.mock("../../../src/lib/project-analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/project-analytics")>();
  return {
    ...actual,
    resolveProjectTrafficSource: vi.fn(async () => ({
      kind: "self-hosted" as const,
      domain: "app.example.com",
      serverId: "srv_1",
    })),
  };
});

import { serverLogStream } from "../../../src/modules/projects/project.controller";

/**
 * An executor with no `forwardPort`, which is what selects the exec transport,
 * running an edge container whose `curl -N` emits `chunks`.
 */
function edgeExecutor(chunks: Buffer[]): CommandExecutor {
  return {
    exec: async (command: string) => (command.includes("docker ps") ? "openship-edge\n" : ""),
    streamExec: async (_command: string, onLog: (log: LogEntry) => void) => {
      for (const chunk of chunks) {
        onLog({
          timestamp: "2026-07-31T00:00:00.000Z",
          message: chunk.toString(),
          level: "info",
          rawData: chunk.toString("base64"),
        });
      }
      return { code: 0, output: "" };
    },
  } as unknown as CommandExecutor;
}

/** What the browser receives when the edge emits `chunks`. */
async function relay(chunks: Buffer[]): Promise<Buffer> {
  h.executor = edgeExecutor(chunks);

  const app = new Hono();
  app.get("/projects/:id/server-logs/stream", serverLogStream);

  const res = await app.request("/projects/proj_1/server-logs/stream");
  return Buffer.from(await res.arrayBuffer());
}

/** Split `frame` inside the multi-byte character `at`. */
function splitMidCharacter(frame: string, at: string): Buffer[] {
  const bytes = Buffer.from(frame, "utf8");
  const cut = bytes.indexOf(Buffer.from(at, "utf8")) + 1;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

describe("serverLogStream relay", () => {
  it("relays a frame split mid-character byte-for-byte", async () => {
    const frame = `event: request\ndata: {"path":"/café","status":200}\n\n`;

    const relayed = await relay(splitMidCharacter(frame, "é"));

    expect(relayed.toString("hex")).toBe(Buffer.from(frame, "utf8").toString("hex"));
  });

  it("keeps a payload parseable AND unmangled across a mid-character split", async () => {
    // U+FFFD is legal inside a JSON string, so parsing alone says nothing about
    // the bytes; the decoded value is what has to match.
    const frame = `event: request\ndata: {"path":"/日本語/index","ua":"Mozilla"}\n\n`;

    const relayed = await relay(splitMidCharacter(frame, "本"));

    const data = relayed
      .toString()
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice(6);
    expect(JSON.parse(data)).toEqual({ path: "/日本語/index", ua: "Mozilla" });
  });

  it("relays several frames split at successive mid-character boundaries", async () => {
    const frame = `event: request\ndata: {"host":"münchen.example"}\n\nevent: request\ndata: {"host":"café.example"}\n\n`;
    const bytes = Buffer.from(frame, "utf8");
    const cuts = [
      bytes.indexOf(Buffer.from("ü", "utf8")) + 1,
      bytes.indexOf(Buffer.from("é", "utf8")) + 1,
    ];

    const relayed = await relay([
      bytes.subarray(0, cuts[0]),
      bytes.subarray(cuts[0], cuts[1]),
      bytes.subarray(cuts[1]),
    ]);

    expect(relayed.toString("hex")).toBe(bytes.toString("hex"));
  });

  it("relays an ASCII frame unchanged", async () => {
    const frame = `event: request\ndata: {"ip":"203.0.113.7"}\n\n: ping\n\n`;

    const relayed = await relay([Buffer.from(frame, "utf8")]);

    expect(relayed.toString()).toBe(frame);
  });
});

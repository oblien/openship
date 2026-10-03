import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenshipClient } from "@repo/sdk/client";
import { buildStatus, deployment, sse } from "./helpers";
import { watchDeployment, watchRuntimeLogs } from "../src/streams";

function sink() {
  const chunks: string[] = [];
  return {
    chunks,
    append: (text: string) => {
      chunks.push(text);
    },
    appendLine: (text: string) => {
      chunks.push(text + "\n");
    },
  };
}

describe("deployment and runtime logs", () => {
  it("reports persisted failure even when SSE claims success", async () => {
    let polls = 0;
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async (input) => {
        if (String(input).endsWith("/stream"))
          return sse(
            'event: complete\ndata: {"success":true}\n\nevent: end\ndata: {"status":"ready"}\n\n',
          );
        return Response.json(
          buildStatus(++polls < 3 ? "building" : "failed", { errorMessage: "Health check failed" }),
        );
      },
    });
    const output = sink();
    const result = await watchDeployment(
      client,
      deployment.id,
      new AbortController().signal,
      output,
      { pollIntervalMs: 10 },
    );
    expect(result).toMatchObject({ status: "failed", success: false });
    expect(output.chunks.join("")).toContain("Health check failed");
  });

  it("loads persisted logs when viewing an already finished deployment", async () => {
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async (input) => {
        if (String(input).includes("/logs"))
          return Response.json({
            data: [{ timestamp: "today", level: "info", message: "Historical build output" }],
          });
        if (String(input).endsWith("/stream"))
          return sse('event: end\ndata: {"status":"ready"}\n\n');
        return Response.json(buildStatus());
      },
    });
    const output = sink();
    expect(
      (await watchDeployment(client, deployment.id, new AbortController().signal, output)).success,
    ).toBe(true);
    expect(output.chunks.join("")).toContain("Historical build output");
  });

  it("resumes disconnected streams by cursor, suppresses duplicates, and preserves split UTF-8", async () => {
    let streams = 0,
      polls = 0;
    const urls: string[] = [];
    const bytes = Buffer.from("日本語");
    const first = `id: 1\nevent: log\ndata: {"data":"${bytes.subarray(0, 2).toString("base64")}"}\n\n`;
    const second = `id: 2\nevent: log\ndata: {"data":"${bytes.subarray(2).toString("base64")}"}\n\nid: 3\nevent: end\ndata: {"status":"ready"}\n\n`;
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/stream")) {
          urls.push(url);
          return sse(++streams === 1 ? first : first + second);
        }
        return Response.json(buildStatus(++polls < 4 ? "building" : "ready"));
      },
    });
    const output = sink();
    await watchDeployment(client, deployment.id, new AbortController().signal, output, {
      pollIntervalMs: 10,
      retryDelayMs: 1,
    });
    expect(urls[1]).toContain("since=1");
    expect(output.chunks.join("")).toContain("日本語");
    expect(output.chunks.join("")).not.toContain("�");
  });

  it("stops transports without sending a deployment cancel request", async () => {
    const abort = new AbortController();
    const cancelled = vi.fn();
    let opened!: () => void;
    const streaming = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url?.endsWith("/stream")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": connected\n\n");
        response.on("close", cancelled);
        opened();
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(buildStatus("building")));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const client = new OpenshipClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      const watching = watchDeployment(client, deployment.id, abort.signal, sink(), {
        pollIntervalMs: 10,
      });
      const rejected = expect(watching).rejects.toThrow();
      await streaming;
      abort.abort();
      await rejected;
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      expect(requests.some((url) => url.endsWith("/cancel"))).toBe(false);
    } finally {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns pending prompts and partial failures without reporting success", async () => {
    for (const status of [
      buildStatus("partial_failure"),
      buildStatus("building", {
        decisionPending: true,
        pendingPrompt: {
          promptId: "p1",
          title: "Port conflict",
          message: "Choose an action",
          actions: [{ id: "abort", label: "Abort" }],
        },
      }),
    ]) {
      const client = new OpenshipClient({
        baseUrl: "https://ship.test",
        fetch: async (input) => {
          if (String(input).includes("/logs")) return Response.json({ data: [] });
          if (String(input).endsWith("/stream")) return sse("event: end\ndata: {}\n\n");
          return Response.json(status);
        },
      });
      const outcome = await watchDeployment(
        client,
        deployment.id,
        new AbortController().signal,
        sink(),
      );
      expect(outcome.success).toBe(false);
      if (status.pendingPrompt)
        expect(outcome).toMatchObject({ status: "action_required", prompt: status.pendingPrompt });
    }
  });

  it("renders runtime log messages and exposes stream errors", async () => {
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async () =>
        sse(
          'event: log\ndata: {"message":"App started"}\n\nevent: error\ndata: {"error":"Container stopped"}\n\n',
        ),
    });
    const output = sink();
    await watchRuntimeLogs(client, "p1", new AbortController().signal, output);
    expect(output.chunks.join("")).toContain("App started");
    expect(output.chunks.join("")).toContain("Container stopped");
  });

  it("uses raw runtime chunks when their text previews split a multibyte character", async () => {
    const bytes = Buffer.from("日本語\n");
    const events = [bytes.subarray(0, 2), bytes.subarray(2)]
      .map(
        (data) =>
          `event: log\ndata: ${JSON.stringify({ data: data.toString("base64"), message: data.toString("utf8") })}\n\n`,
      )
      .join("");
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async () => sse(events),
    });
    const output = sink();
    await watchRuntimeLogs(client, "p1", new AbortController().signal, output);
    expect(output.chunks.join("")).toContain("日本語\n");
    expect(output.chunks.join("")).not.toContain("�");
  });
});

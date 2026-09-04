import { afterEach, describe, expect, it, vi } from "vitest";

import { dataTransferApi, inspectDirectTransferCode } from "./data-transfer";

function captureRequest() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).endsWith("/direct/send/stream")) {
      return new Response(
        `: ok\n\nevent: complete\ndata: ${JSON.stringify({
          mode: "wipe",
          rowsRestored: 0,
          secretsRehydrated: 0,
          secretsSkipped: true,
          localPathProjects: [],
          destination: "https://destination.example",
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(JSON.stringify({ kind: "openship-instance-export" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("data-transfer export selection", () => {
  it("shows the destination and restore mode encoded in a receive code", () => {
    const code = btoa(
      JSON.stringify({
        apiBase: "https://destination.example/api/",
        mode: "wipe",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(inspectDirectTransferCode(code)).toEqual({
      destination: "https://destination.example",
      mode: "wipe",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  it("loads the lightweight pre-export row counts", async () => {
    const fetchMock = captureRequest();
    await dataTransferApi.preview();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("system/data-transfer/preview");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");
  });

  it("sends the operator's selected history groups", async () => {
    const fetchMock = captureRequest();
    await dataTransferApi.export("move-secret", ["analytics", "backups"]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      passphrase: "move-secret",
      selection: { history: ["analytics", "backups"] },
    });
  });

  it("omits selection for legacy callers instead of silently requesting core-only", async () => {
    const fetchMock = captureRequest();
    await dataTransferApi.export("move-secret");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ passphrase: "move-secret" });
  });

  it("creates a direct receive capability using this instance API base", async () => {
    const fetchMock = captureRequest();
    await dataTransferApi.createDirectReceiveSession("wipe");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("system/data-transfer/direct/session");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ mode: "wipe" });
    expect(JSON.parse(String(init.body)).apiBase).toContain("/api/");
  });

  it("sends the one-time code and full migration history to the source API", async () => {
    const fetchMock = captureRequest();
    await dataTransferApi.sendDirect("receive-code", [
      "analytics",
      "activity",
      "backups",
      "incidents",
      "migrations",
    ]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("system/data-transfer/direct/send");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      code: "receive-code",
      selection: { history: ["analytics", "activity", "backups", "incidents", "migrations"] },
    });
  });

  it("imports a file as bounded raw chunks without reading the whole file", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/finalize/stream")) {
        return new Response(
          `event: complete\ndata: ${JSON.stringify({
            mode: "merge",
            rowsRestored: 2,
            secretsRehydrated: 0,
            secretsSkipped: true,
            localPathProjects: [],
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      const value = url.endsWith("/import/session")
        ? {
            uploadId: "upload_1",
            chunkSize: 4,
            totalChunks: 3,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }
        : { ok: true };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const file = new File(["hello world"], "export.osx", { type: "application/json" });

    const result = await dataTransferApi.importFile(file, undefined, "merge", progress);

    expect(result.rowsRestored).toBe(2);
    expect(requests).toHaveLength(5);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ size: 11 });
    const chunks = requests.slice(1, 4);
    expect(chunks.map(({ init }) => init.method)).toEqual(["PUT", "PUT", "PUT"]);
    expect(chunks.every(({ init }) => init.body instanceof Blob)).toBe(true);
    expect(
      chunks.every(
        ({ init }) => new Headers(init.headers).get("content-type") === "application/octet-stream",
      ),
    ).toBe(true);
    expect(await Promise.all(chunks.map(({ init }) => (init.body as Blob).text()))).toEqual([
      "hell",
      "o wo",
      "rld",
    ]);
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(JSON.parse(String(requests[4]!.init.body))).toEqual({ mode: "merge" });
  });

  it("reuses verified chunks when the operator retries finalization", async () => {
    let finalizes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/import/session")) {
        return Response.json({
          uploadId: "upload_retry",
          chunkSize: 20,
          totalChunks: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.endsWith("/finalize/stream")) {
        finalizes += 1;
        const terminal =
          finalizes === 1
            ? {
                event: "error",
                data: { status: 400, error: "Wrong transfer secret", code: "WRONG_PASSPHRASE" },
              }
            : {
                event: "complete",
                data: {
                  mode: "merge",
                  rowsRestored: 1,
                  secretsRehydrated: 1,
                  secretsSkipped: false,
                  localPathProjects: [],
                },
              };
        return new Response(
          `event: ${terminal.event}\ndata: ${JSON.stringify(terminal.data)}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["small export"], "export.json");

    await expect(dataTransferApi.importFile(file, "wrong", "merge")).rejects.toThrow();
    await expect(dataTransferApi.importFile(file, "correct", "merge")).resolves.toMatchObject({
      rowsRestored: 1,
    });

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.endsWith("/import/session"))).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === "PUT"),
    ).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/finalize/stream"))).toHaveLength(2);
  });

  it("starts a fresh upload after a cached session expires during chunking", async () => {
    let sessions = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/import/session")) {
        sessions += 1;
        return Response.json({
          uploadId: sessions === 1 ? "expired" : "fresh",
          chunkSize: 20,
          totalChunks: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (init?.method === "PUT" && url.includes("/expired/")) {
        return Response.json(
          { error: "Upload expired", code: "SESSION_UNAVAILABLE" },
          { status: 410 },
        );
      }
      if (url.endsWith("/finalize/stream")) {
        return new Response(
          `event: complete\ndata: ${JSON.stringify({
            mode: "merge",
            rowsRestored: 1,
            secretsRehydrated: 0,
            secretsSkipped: true,
            localPathProjects: [],
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["small export"], "export.json");

    await expect(dataTransferApi.importFile(file, undefined, "merge")).resolves.toMatchObject({
      rowsRestored: 1,
    });

    expect(sessions).toBe(2);
  });
});

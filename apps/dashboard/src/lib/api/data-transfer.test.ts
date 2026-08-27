import { afterEach, describe, expect, it, vi } from "vitest";

import { dataTransferApi, inspectDirectTransferCode } from "./data-transfer";

function captureRequest() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ kind: "openship-instance-export" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("data-transfer export selection", () => {
  it("shows the destination and restore mode encoded in a receive code", () => {
    const code = btoa(JSON.stringify({
      apiBase: "https://destination.example/api/",
      mode: "wipe",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
    await dataTransferApi.sendDirect("receive-code", ["analytics", "activity", "backups", "incidents", "migrations"]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("system/data-transfer/direct/send");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      code: "receive-code",
      selection: { history: ["analytics", "activity", "backups", "incidents", "migrations"] },
    });
  });
});

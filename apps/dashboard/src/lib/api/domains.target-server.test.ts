import { afterEach, describe, expect, it, vi } from "vitest";

import { domainsApi } from "./domains";

function captureRequest() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ data: { mode: "selfhosted", records: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("domain DNS target forwarding", () => {
  it.each([
    ["records", () => domainsApi.records("dom_1", "server_new"), "GET"],
    ["plan", () => domainsApi.dnsPlan("dom_1", "server_new"), "GET"],
    ["apply", () => domainsApi.dnsApply("dom_1", "server_new"), "POST"],
  ] as const)("sends the selected server to DNS %s", async (_name, request, method) => {
    const fetchMock = captureRequest();

    await request();

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("serverId")).toBe("server_new");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe(method);
  });
});

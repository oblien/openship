import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { WSContext, WSEvents } from "hono/ws";
import type { ExecutionContext } from "@repo/platform";

const h = vi.hoisted(() => ({ authority: vi.fn(), authorize: vi.fn(), permission: vi.fn(), identity: vi.fn(), fetch: vi.fn() }));
vi.mock("@repo/platform/engine/lib/cloud/resource-authority", () => ({ resolveResourceAuthority: h.authority }));
vi.mock("@repo/platform/engine/lib/authorization", () => ({ authorization: { authorize: h.authorize, checkPermissionOnResource: h.permission } }));
vi.mock("../../src/lib/terminal-authorization", () => ({ refreshTerminalContext: async (ctx: unknown) => ctx }));
vi.mock("@repo/platform/engine/lib/cloud/server-link", () => ({ linkedCloudIdentity: h.identity }));
vi.mock("@repo/platform/engine/lib/cloud/transport", () => ({
  cloudFetchAsOrgOwner: h.fetch,
  sameCloudIdentity: (a: Record<string, string>, b: Record<string, string>) =>
    ["apiUrl", "userId", "organizationId"].every(key => a[key] === b[key]),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: { TERMINAL_MAX_SESSIONS_PER_USER: 2 }, cloudRuntimeTarget: { dashboard: "https://app.example.test" },
}));
import { cloudTerminalHandlers, prepareCloudTerminal } from "../../src/lib/cloud/terminal-bridge";

const ctx = { userId: "local-user", organizationId: "local-org", role: "owner", scopeMode: "resource" } as ExecutionContext;
const token = "one_shot_upstream_ticket";
const identity = { apiUrl: "http://127.0.0.1", userId: "cloud-user", organizationId: "cloud-org" };
let server: WebSocketServer;
const bridges: WSEvents[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  h.authority.mockResolvedValue("cloud"); h.authorize.mockResolvedValue(ctx);
  h.identity.mockImplementation(async () => ({ ...identity })); h.permission.mockResolvedValue(true);
  h.fetch.mockImplementation(async () => Response.json({ success: true, token }));
});
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.onClose?.({} as never, {} as WSContext);
  if (server) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.useRealTimers();
});

async function start() {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  identity.apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function makeBridge(kind: "server" | "service" = "service", resumeToken = "") {
  const client = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
  const handlers = cloudTerminalHandlers({ kind, id: "cloud-resource", context: ctx,
    cloud: { identity: { ...identity }, token }, resumeToken });
  bridges.push(handlers);
  return { handlers, client };
}
async function connect(kind: "server" | "service" = "service") {
  const connection = once(server, "connection");
  const bridge = makeBridge(kind);
  await bridge.handlers.onOpen?.({} as never, bridge.client as unknown as WSContext);
  const [peer, request] = await connection;
  return { ...bridge, peer: peer as WebSocket, request };
}

describe("Cloud terminal authorization", () => {
  it.each(["server", "service"] as const)("mints a %s ticket only after the existing admin gate", async kind => {
    expect(await prepareCloudTerminal(ctx, kind, "cloud-resource")).toEqual({ identity, token });
    expect(h.authorize).toHaveBeenCalledWith(ctx, { resourceType: kind, resourceId: "cloud-resource", action: "admin" });
    expect(h.fetch).toHaveBeenCalledWith(ctx.organizationId, kind === "server" ? "/api/terminal/ticket" : "/api/services/terminal/ticket",
      { method: "POST", body: JSON.stringify({ [`${kind}Id`]: "cloud-resource" }) }, identity);
  });
  it("keeps local terminals local", async () => {
    h.authority.mockResolvedValue("local");
    expect(await prepareCloudTerminal(ctx, "server", "local-server")).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([{ scopeMode: "fixed" }, { tokenScope: { tokenId: "scoped" } }, { role: "restricted" }, { credential: { organizationId: "local-org" } }])("rejects local credential scope: %j", async restriction => {
    await expect(prepareCloudTerminal({ ...ctx, ...restriction } as ExecutionContext, "service", "cloud-service"))
      .rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not mint upstream when local admin permission is denied", async () => {
    h.authorize.mockRejectedValue(new Error("Not authorized"));
    await expect(prepareCloudTerminal(ctx, "service", "cloud-service")).rejects.toThrow("Not authorized");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([{ success: true, token: "malformed" }, { success: false, token }])("refuses malformed ticket responses", async body => {
    h.fetch.mockImplementationOnce(async () => Response.json(body));
    await expect(prepareCloudTerminal(ctx, "service", "cloud-service")).rejects.toMatchObject({ code: "INVALID_CLOUD_RESPONSE" });
  });
});

describe("real WebSocket terminal relay", () => {
  it.each(["server", "service"] as const)("relays the existing %s protocol without forwarding browser credentials", async kind => {
    await start();
    const { handlers, client, peer, request } = await connect(kind);
    expect(request.url).toBe(kind === "server" ? "/api/terminal/ws/cloud-resource" : "/api/services/terminal/ws/cloud-resource");
    expect(request.headers.origin).toBe("https://app.example.test");
    expect(request.headers["sec-websocket-protocol"]).toBe(`openship.terminal.v1+${token}`);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    const message = once(peer, "message");
    handlers.onMessage?.({ data: new TextEncoder().encode("echo hello\n").buffer } as never, client as unknown as WSContext);
    expect((await message)[0].toString()).toBe("echo hello\n");
    peer.send(JSON.stringify({ type: "ready", sessionId: "cloud-session" }));
    peer.send(Buffer.from("hello\r\n"), { binary: true });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(2));
    expect(client.send.mock.calls[0][0]).toBe('{"type":"ready","sessionId":"cloud-session"}');
    expect(new TextDecoder().decode(client.send.mock.calls[1][0])).toBe("hello\r\n");
    const closed = once(peer, "close");
    handlers.onClose?.({} as never, client as unknown as WSContext);
    await closed;
  });

  it("refuses a ticket from a previous Cloud account before opening a socket", async () => {
    await start();
    const accepted = vi.fn(); server.on("connection", accepted);
    const { handlers, client } = makeBridge();
    h.identity.mockResolvedValue({ ...identity, userId: "another-user" });
    await handlers.onOpen?.({} as never, client as unknown as WSContext);
    expect(client.close).toHaveBeenCalledWith(4401, expect.any(String));
    expect(accepted).not.toHaveBeenCalled();
  });

  it("terminates the old shell when permissions are revoked during a live connection", async () => {
    await start();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { client, peer } = await connect();
    // Let the client's upgrade finish before triggering reauthorization.
    peer.send("ready");
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    h.permission.mockResolvedValue(false);
    const message = once(peer, "message");
    await vi.advanceTimersByTimeAsync(5000);
    expect(JSON.parse((await message)[0].toString())).toEqual({ type: "close" });
    expect(client.close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  it("enforces admission limits and releases a disconnected bridge", async () => {
    await start();
    const first = await connect();
    await connect();
    const denied = makeBridge();
    await denied.handlers.onOpen?.({} as never, denied.client as unknown as WSContext);
    expect(denied.client.close).toHaveBeenCalledWith(4429, expect.any(String));
    first.handlers.onClose?.({} as never, first.client as unknown as WSContext);
    const next = await connect();
    expect(next.client.close).not.toHaveBeenCalled();
  });
});

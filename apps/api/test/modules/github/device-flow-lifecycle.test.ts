import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/platform/engine/config/env", async original => {
  const module = await original<{ env: Record<string, unknown> }>();
  return { ...module, env: { ...module.env, GITHUB_AUTH_MODE: "cli", GITHUB_DEVICE_CLIENT_ID: "test-client" } };
});
import { seedOwner, seedServer, repos } from "../jobs/_harness";
import { startServerDeviceFlow, startDeviceFlow, cancelDeviceFlow, getDeviceFlowStatus, closeDeviceFlows, setStoredDeviceToken } from "@repo/platform/engine/modules/github/github.local-auth";
import { startServerConnect } from "@repo/platform/engine/modules/github/server-github.service";
import { authorization } from "@repo/platform/engine/lib/authorization";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";

const exchanges: Array<{ approve(token: string): void; signal: AbortSignal }> = [];
let seq = 0;
beforeEach(() => {
  exchanges.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/login/device/code")) return Response.json({ device_code: `device-${++seq}`, user_code: "ABCD", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 });
    if (url.endsWith("/login/oauth/access_token")) return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal!;
      const abort = () => reject(new DOMException("Canceled", "AbortError"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      exchanges.push({ signal, approve(token) { signal.removeEventListener("abort", abort); resolve(Response.json({ access_token: token, token_type: "bearer", scope: "repo" })); } });
    });
    if (url.startsWith("https://api.github.com/user")) return Response.json({ login: "operator", id: 1, avatar_url: "" });
    throw new Error(`Unexpected provider request: ${url}`);
  }));
});
afterEach(async () => { await closeDeviceFlows(); await drainBackgroundWork(); await setStoredDeviceToken(null); vi.unstubAllGlobals(); });
const waitForExchange = async (index = 0) => { await vi.waitFor(() => expect(exchanges.length).toBeGreaterThan(index)); return exchanges[index]!; };

describe("owned GitHub device authorization", () => {
  it("aborts a canceled provider request and never stores a late approval", async () => {
    const persist = vi.fn();
    await startServerDeviceFlow("server:cancel", persist);
    const exchange = await waitForExchange();
    await cancelDeviceFlow("server:cancel");
    expect(exchange.signal.aborted).toBe(true);
    exchange.approve("late-token");
    await drainBackgroundWork();
    expect(persist).not.toHaveBeenCalled();
    expect(getDeviceFlowStatus("server:cancel")).toBeNull();
  });

  it("reports completion only after persistence and never includes the provider token", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const persist = vi.fn(() => gate);
    await startServerDeviceFlow("server:complete", persist);
    (await waitForExchange()).approve("private-provider-token");
    await vi.waitFor(() => expect(persist).toHaveBeenCalledWith("private-provider-token"));
    expect(getDeviceFlowStatus("server:complete")).toEqual({ status: "waiting" });
    finish();
    await drainBackgroundWork();
    expect(getDeviceFlowStatus("server:complete")).toEqual({ status: "complete" });
    expect(getDeviceFlowStatus("server:complete")).toBeNull();
  });

  it("waits for an already-started write before replacing the same authorization flow", async () => {
    let finish!: () => void;
    const persist = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await startServerDeviceFlow("server:replace", persist);
    (await waitForExchange()).approve("old-token");
    await vi.waitFor(() => expect(persist).toHaveBeenCalled());
    let replaced = false;
    const nextPersist = vi.fn();
    const replacement = startServerDeviceFlow("server:replace", nextPersist).then(() => { replaced = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(replaced).toBe(false);
    finish();
    await replacement;
    (await waitForExchange(1)).approve("new-token");
    await drainBackgroundWork();
    expect(nextPersist).toHaveBeenCalledExactlyOnceWith("new-token");
  });

  it("rechecks the saved instance and server actor after credential revocation", async () => {
    const actor = await seedOwner({ instanceAdmin: true }), user = (await repos.user.findById(actor.userId))!;
    const token = (await repos.personalAccessToken.listByUser(actor.userId))[0]!;
    const context = await authorization.resolveScope({ user, sessionId: `pat:${token.id}`, principalKind: "pat", credential: { organizationId: null, readOnly: false } }, actor.orgId);
    await startDeviceFlow(context);
    const server = await seedServer(actor.orgId);
    await startServerConnect(context, server);
    await waitForExchange(1);
    await repos.personalAccessToken.revoke(token.id, actor.userId);
    exchanges[0]!.approve("revoked-instance-token");
    exchanges[1]!.approve("revoked-server-token");
    await drainBackgroundWork();
    expect(getDeviceFlowStatus(actor.userId)).toMatchObject({ status: "error" });
    expect(getDeviceFlowStatus(`server:${server}`)).toMatchObject({ status: "error" });
    expect((await repos.instanceSettings.get())?.ghDeviceTokenEncrypted ?? null).toBeNull();
    expect(await repos.serverGithubAuth.getByServer(server)).toBeUndefined();
  });
});

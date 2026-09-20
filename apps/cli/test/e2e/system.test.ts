import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextCaps } from "../../src/lib/config";
const h = vi.hoisted(() => ({ caps: undefined as ContextCaps | undefined }));
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test", getToken: () => "token", getActiveContext: () => "test",
  getContext: () => ({ caps: h.caps }), updateContext: (_name: string, patch: { caps: ContextCaps }) => { h.caps = patch.caps; },
}));

import { systemCommand } from "../../src/commands/system";
import { instanceSettingsFixture, systemInfoFixture } from "../../../../packages/contracts/test/fixtures";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
beforeEach(() => { h.caps = undefined; });
afterEach(() => { fetchStub?.restore(); setJsonMode(false); });

describe("system commands through the SDK", () => {
  it("discovers capabilities and returns typed settings in JSON mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(req => ({ json: req.url.endsWith("/health/env") ? systemInfoFixture() : instanceSettingsFixture() }));
    const result = await runCommand(systemCommand, ["settings", "get"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(instanceSettingsFixture());
    expect(fetchStub.calls.map(req => req.url)).toEqual(["http://api.test/api/health/env", "http://api.test/api/system/settings"]);
  });

  it("preserves auth-mode confirmation and server error details", async () => {
    fetchStub = stubFetch(req => req.url.endsWith("/health/env") ? { json: systemInfoFixture() } : { status: 409, json: { error: "Auth mode is pinned", code: "INVALID_INSTANCE_SETTINGS" } });
    const result = await runCommand(systemCommand, ["settings", "set", "--auth-mode", "none", "--confirm", "I-understand-no-auth"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Auth mode is pinned");
    expect(fetchStub.calls[1]).toMatchObject({ method: "PATCH", body: { authMode: "none", confirm: "I-understand-no-auth" } });
  });

  it("encodes folder paths once and preserves the structured browse output", async () => {
    setJsonMode(true);
    const body = { path: "/work/a # project", directories: [] };
    fetchStub = stubFetch(req => ({ json: req.url.endsWith("/health/env") ? systemInfoFixture() : body }));
    const result = await runCommand(systemCommand, ["browse", body.path]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(body);
    expect(new URL(fetchStub.calls[1]!.url).searchParams.get("path")).toBe(body.path);
  });

  it("refuses a self-hosted mutation against a cloud target before submission", async () => {
    fetchStub = stubFetch(() => ({ json: { ...systemInfoFixture(), selfHosted: false } }));
    const result = await runCommand(systemCommand, ["settings", "set", "--default-build-mode", "auto"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("self-hosted");
    expect(fetchStub.calls).toHaveLength(1);
  });
});

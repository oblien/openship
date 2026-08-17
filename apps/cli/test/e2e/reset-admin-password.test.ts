import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * `openship reset-admin-password` against a box of each install method.
 *
 * The reported failure: on a Compose install this command answered "Reset failed:
 * Unauthorized" every single time. It authenticated with `~/.openship/internal-token`,
 * which the compose path never writes — so on a compose-only box it MINTED a fresh
 * random token, sent that, and the api container (booted from the INTERNAL_TOKEN in
 * `compose/.env`) refused it. The lockout-recovery command was unusable on exactly the
 * installs that most need it.
 *
 * Driven through the real command with a fake filesystem, because the bug lived in which
 * FILE was read — asserting on the header the command sends is the only way to pin it.
 */

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  denied: new Set<string>(),
  writes: new Map<string, string>(),
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => h.files.has(String(p)),
  mkdirSync: () => undefined,
  readFileSync: (p: string) => {
    const path = String(p);
    if (h.denied.has(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
    const v = h.files.get(path);
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    h.writes.set(String(p), String(data));
    h.files.set(String(p), String(data));
  },
}));

import { resetAdminCommand } from "../../src/commands/reset-admin";
import { COMPOSE_ENV_FILE, COMPOSE_FILE } from "../../src/lib/compose-env";
import { INTERNAL_TOKEN_FILE } from "../../src/lib/paths";
import { PORTS_FILE } from "../../src/lib/ports";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub | undefined;

const resetCall = () =>
  fetchStub!.calls.find((c) => c.url.endsWith("/api/system/reset-admin-password"));

beforeEach(() => {
  h.files.clear();
  h.denied.clear();
  h.writes.clear();
  // The port this install resolved to — not the 4000 default, so a command that
  // ignored ports.json would miss.
  h.files.set(PORTS_FILE, JSON.stringify({ api: 4123, dashboard: 3001 }));
  fetchStub = stubFetch((req) =>
    req.headers["x-internal-token"] === "stack-token" || req.headers["x-internal-token"] === "bare-token"
      ? { status: 200, json: { ok: true, email: "admin@example.com" } }
      : { status: 401, json: { error: "Unauthorized" } },
  );
});
afterEach(() => {
  fetchStub?.restore();
  fetchStub = undefined;
});

describe("openship reset-admin-password", () => {
  it("authenticates with the STACK's token on a compose install", async () => {
    h.files.set(COMPOSE_FILE, "services: {}\n");
    h.files.set(COMPOSE_ENV_FILE, "INTERNAL_TOKEN=stack-token\nAPI_PORT=4123\n");

    const r = await runCommand(resetAdminCommand, ["--password", "hunter2hunter2"]);

    expect(r.code).toBe(0);
    expect(resetCall()!.url).toBe("http://127.0.0.1:4123/api/system/reset-admin-password");
    expect(resetCall()!.headers["x-internal-token"]).toBe("stack-token");
    expect((resetCall()!.body as any).password).toBe("hunter2hunter2");
    expect(r.out).toContain("admin@example.com");
    // The old behaviour in one assertion: a reader must not create a token, because a
    // token nothing is running with can only ever be refused.
    expect([...h.writes.keys()]).not.toContain(INTERNAL_TOKEN_FILE);
  });

  it("authenticates with the bare token file on a bare install", async () => {
    h.files.set(INTERNAL_TOKEN_FILE, "bare-token\n");

    const r = await runCommand(resetAdminCommand, ["--password", "hunter2hunter2"]);

    expect(r.code).toBe(0);
    expect(resetCall()!.headers["x-internal-token"]).toBe("bare-token");
  });

  it("tells the operator to use sudo when the stack's .env is root-owned", async () => {
    h.files.set(COMPOSE_FILE, "services: {}\n");
    h.files.set(COMPOSE_ENV_FILE, "INTERNAL_TOKEN=stack-token\n");
    h.denied.add(COMPOSE_ENV_FILE);

    const r = await runCommand(resetAdminCommand, ["--password", "hunter2hunter2"]);

    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/sudo/);
    // A permissions problem must not be reported as a credentials one, and must not
    // send a doomed request at all.
    expect(r.out + r.err).not.toMatch(/Unauthorized/);
    expect(resetCall()).toBeUndefined();
  });

  it("explains a 401 as a token mismatch rather than echoing 'Unauthorized'", async () => {
    // Both stores hold something the running api doesn't have — e.g. `.env` was
    // regenerated while the container kept the old value.
    h.files.set(COMPOSE_FILE, "services: {}\n");
    h.files.set(COMPOSE_ENV_FILE, "INTERNAL_TOKEN=rotated-token\n");
    h.files.set(INTERNAL_TOKEN_FILE, "older-token\n");

    const r = await runCommand(resetAdminCommand, ["--password", "hunter2hunter2"]);

    expect(r.code).toBe(1);
    const text = r.out + r.err;
    expect(text).toMatch(/running with a different one/);
    expect(text).toMatch(/openship up/);
    // Both candidates were tried before giving up.
    expect(fetchStub!.calls.map((c) => c.headers["x-internal-token"])).toEqual([
      "rotated-token",
      "older-token",
    ]);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Which internal token the CLI authenticates a running API with.
 *
 * `openship reset-admin-password` failed with "Reset failed: Unauthorized" on EVERY
 * compose install, and the reason was not a sync bug — it called the MINTING helper, so
 * on a box whose token lives in `compose/.env` it generated a brand-new random token,
 * sent that, and could only ever be refused. The api container refuses it outright:
 * DEPLOY_MODE is "docker" there, and internalAuth has no loopback-peer fallback outside
 * desktop.
 *
 * So these cases pin the two halves of the fix:
 *   · readers RESOLVE from whichever store the running API was booted with, in evidence
 *     order, and never mint (a token nothing is running with is a guaranteed 401);
 *   · a store that exists but won't open — the root-owned 0600 `.env` a `sudo openship
 *     up` leaves behind — is a PERMISSIONS problem with its own message, not an
 *     authorization failure.
 */

const h = vi.hoisted(() => ({
  /** Files this fake box has, by absolute path → contents. */
  files: new Map<string, string>(),
  /** Paths whose read throws EACCES instead of returning contents. */
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

import { COMPOSE_ENV_FILE, COMPOSE_FILE } from "../../src/lib/compose-env";
import {
  internalTokenProblem,
  internalTokenRejectedProblem,
  internalTokenSources,
  mintBareInternalToken,
  resolveInternalToken,
} from "../../src/lib/internal-token";
import { INTERNAL_TOKEN_FILE } from "../../src/lib/paths";

/** A compose install: the compose file is the evidence, the `.env` holds the secret. */
function composeInstall(token: string | null): void {
  h.files.set(COMPOSE_FILE, "services: {}\n");
  h.files.set(
    COMPOSE_ENV_FILE,
    ["COMPOSE_PROJECT_NAME=openship", ...(token ? [`INTERNAL_TOKEN=${token}`] : []), "API_PORT=4000"].join("\n"),
  );
}

function bareInstall(token: string): void {
  h.files.set(INTERNAL_TOKEN_FILE, `${token}\n`);
}

beforeEach(() => {
  h.files.clear();
  h.denied.clear();
  h.writes.clear();
});

describe("internal token resolution", () => {
  it("uses the stack's .env token on a compose install", () => {
    composeInstall("compose-token");
    expect(resolveInternalToken()).toBe("compose-token");
    // The bug in one assertion: nothing was created to authenticate with.
    expect(h.writes.size).toBe(0);
  });

  it("uses the bare token file on a bare install", () => {
    bareInstall("bare-token");
    expect(resolveInternalToken()).toBe("bare-token");
    expect(h.writes.size).toBe(0);
  });

  it("tries the compose token FIRST on a box that has both, keeping the bare one as a fallback", () => {
    // A box installed bare and later converted: both stores exist, and the api that is
    // actually listening is the container's. The stale file must not win, but it stays a
    // candidate so a 401 on the first can be retried rather than reported.
    bareInstall("stale-bare-token");
    composeInstall("live-compose-token");
    expect(internalTokenSources().tokens).toEqual(["live-compose-token", "stale-bare-token"]);
  });

  it("reports an unreadable .env as a permissions problem, not an auth failure", () => {
    composeInstall("compose-token");
    h.denied.add(COMPOSE_ENV_FILE);

    expect(resolveInternalToken()).toBeNull();
    const problem = internalTokenProblem();
    expect(problem).toContain(COMPOSE_ENV_FILE);
    expect(problem).toMatch(/sudo/);
    // What the operator must NOT be told: that they aren't authorized.
    expect(problem).not.toMatch(/unauthorized/i);
  });

  it("still names the unreadable .env when a leftover bare token is refused", () => {
    // The nastiest shape: `.env` is root-owned, so resolution falls back to a bare token
    // left over from a previous install — which the stack refuses. Reporting only "the API
    // rejected your token" would bury the one problem that has a fix.
    composeInstall("compose-token");
    h.denied.add(COMPOSE_ENV_FILE);
    bareInstall("leftover-bare-token");

    expect(resolveInternalToken()).toBe("leftover-bare-token");
    const rejected = internalTokenRejectedProblem();
    expect(rejected).toMatch(/sudo/);
    expect(rejected).toContain(COMPOSE_ENV_FILE);
  });

  it("names the compose .env when the stack exists but the token key is gone", () => {
    composeInstall(null);
    expect(resolveInternalToken()).toBeNull();
    expect(internalTokenProblem()).toMatch(/openship up/);
  });

  it("resolves to null — never a fresh token — on a box with no install", () => {
    expect(resolveInternalToken()).toBeNull();
    expect(internalTokenSources().tokens).toEqual([]);
    expect(h.writes.size).toBe(0);
    expect(internalTokenProblem()).toContain(INTERNAL_TOKEN_FILE);
  });

  it("ignores an empty bare token file", () => {
    h.files.set(INTERNAL_TOKEN_FILE, "\n");
    expect(resolveInternalToken()).toBeNull();
  });

  it("mints only for the launcher, and reuses the file once it exists", () => {
    // The bare launcher's path: it boots the service WITH this value, which is what
    // makes the file authoritative. Kept separate from resolution on purpose.
    const minted = mintBareInternalToken();
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(h.writes.get(INTERNAL_TOKEN_FILE)).toBe(minted);
    expect(mintBareInternalToken()).toBe(minted);
  });
});

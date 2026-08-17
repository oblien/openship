import { afterEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import { lsRemoteWithToken } from "../../../src/modules/github/clone-access-test";

afterEach(() => {
  execFile.mockReset();
});

describe("lsRemoteWithToken", () => {
  it("invokes git ls-remote without putting the token on argv", async () => {
    execFile.mockImplementation((_file, _args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      done(null, "", "");
    });

    const ok = await lsRemoteWithToken("https://github.com/acme/web.git", "ghp_secret_token");
    expect(ok).toBe(true);

    const call = execFile.mock.calls[0];
    expect(call[0]).toBe("git");
    const argv = JSON.stringify(call[1]);
    expect(argv).not.toContain("ghp_secret_token");
    expect(call[1]).toContain("ls-remote");
    expect(call[1]).toContain("https://github.com/acme/web.git");
    const env = (call[2] as { env?: Record<string, string> }).env;
    expect(env?.OPENSHIP_GIT_TOKEN).toBe("ghp_secret_token");
    expect(env?.GIT_ASKPASS).toBeTruthy();
  });

  it("returns false when git rejects the remote", async () => {
    execFile.mockImplementation((_file, _args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      done(Object.assign(new Error("denied"), { code: 128 }));
    });
    await expect(lsRemoteWithToken("https://github.com/acme/web.git", "ghp_x")).resolves.toBe(false);
  });
});

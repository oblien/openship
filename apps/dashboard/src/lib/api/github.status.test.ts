import { afterEach, describe, expect, it, vi } from "vitest";
import { githubApi } from "./github";

afterEach(() => {
  githubApi.invalidateStatus();
  vi.unstubAllGlobals();
});

describe("GitHub reads after installation", () => {
  it("a forced refresh reads the new connection while an older read is still pending", async () => {
    let resolveOldRead!: (value: Response) => void;
    const oldRead = new Promise<Response>((resolve) => {
      resolveOldRead = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce(Response.json({ connected: true }));
    vi.stubGlobal("fetch", fetch);

    const beforeInstall = githubApi.getStatusDeduped();
    const concurrentRead = githubApi.getStatusDeduped();
    const afterInstall = githubApi.getStatusDeduped(true);

    // Release both responses even on the buggy implementation: when forced
    // refresh wrongly reuses the old request it returns false rather than hangs.
    resolveOldRead(Response.json({ connected: false }));
    expect(await afterInstall).toEqual({ connected: true });
    expect(await beforeInstall).toEqual({ connected: false });
    expect(await concurrentRead).toEqual({ connected: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed read and allows a fresh retry without an unhandled cleanup rejection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: "Sign in again" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ connected: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(githubApi.getStatusDeduped(true)).rejects.toMatchObject({ status: 401 });
    await expect(githubApi.getStatusDeduped()).resolves.toEqual({ connected: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse another connection attempt's pending completion probe", async () => {
    let resolveOldRead!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOldRead = resolve;
        }),
      )
      .mockResolvedValueOnce(Response.json({ connected: false }));
    vi.stubGlobal("fetch", fetch);

    const oldAttempt = githubApi.getStatus({ includeInstallUrl: false });
    const currentAttempt = githubApi.getStatus({ includeInstallUrl: false });
    resolveOldRead(Response.json({ connected: true }));
    expect(await currentAttempt).toEqual({ connected: false });
    expect(await oldAttempt).toEqual({ connected: true });
  });

  it("refreshes repository access without sharing the pre-install empty response", async () => {
    let resolveOldRead!: (value: Response) => void;
    const accessible = { data: [{ name: "newly-accessible-repo" }] };
    const fetch = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOldRead = resolve;
        }),
      )
      .mockResolvedValueOnce(Response.json(accessible));
    vi.stubGlobal("fetch", fetch);

    const oldAccess = githubApi.getUserRepos("installer", { page: 1 });
    const installedAccess = githubApi.getUserRepos("installer", { page: 1 }, true);
    resolveOldRead(Response.json({ data: [] }));
    expect(await installedAccess).toEqual(accessible);
    expect(await oldAccess).toEqual({ data: [] });
  });
});

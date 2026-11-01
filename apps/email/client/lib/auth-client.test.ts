import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { signIn } from "./auth-client";

const input = { email: "user@example.test", password: "test-only" };
afterEach(() => mock.restore());

describe("webmail sign-in errors", () => {
  it("preserves the distinction between bad credentials and an unavailable backend", async () => {
    const fetcher = spyOn(globalThis, "fetch");
    for (const [status, error] of [
      [401, "Invalid email or password"],
      [503, "Webmail cannot reach the mail server."],
    ] as const) {
      fetcher.mockResolvedValueOnce(Response.json({ error }, { status }));
      expect(await signIn.email(input)).toEqual({ error: { message: error } });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("explains a browser connection failure without exposing a raw fetch error", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await signIn.email(input)).toEqual({
      error: { message: "Cannot reach webmail. Check your connection and try again." },
    });
  });

  it("handles an HTML gateway error as temporary unavailability", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<h1>Bad Gateway</h1>", { status: 502 }),
    );
    expect(await signIn.email(input)).toEqual({
      error: { message: "Webmail is temporarily unavailable. Try again shortly." },
    });
  });

  it("does not claim a successful login when its session cannot be confirmed", async () => {
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json(null));
    expect(await signIn.email(input)).toEqual({
      error: { message: "Could not confirm your sign-in. Please try again." },
    });
  });

  it("confirms the session with cookies before reporting success", async () => {
    const fetcher = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({ email: input.email, name: null, expiresAt: "2099-01-01" }),
      );
    expect(await signIn.email(input)).toEqual({ error: null });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      body: JSON.stringify(input),
    });
    expect(fetcher.mock.calls[1]?.[1]).toEqual({ credentials: "include", signal: expect.any(AbortSignal) });
  });

  it("does not report success if the browser retained another mailbox session", async () => {
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({ email: "other@example.test", name: null, expiresAt: "2099-01-01" }),
      );
    expect((await signIn.email(input)).error?.message).toBe(
      "Could not confirm your sign-in. Please try again.",
    );
  });

  it.each(["sign-in", "session confirmation"])("aborts a stalled %s so the form can retry", async (stage) => {
    const setTimer = globalThis.setTimeout;
    const shortTimer = Object.assign(
      (callback: Parameters<typeof setTimeout>[0]) => setTimer(callback, 10),
      { __promisify__: setTimer.__promisify__ },
    );
    // Replace this function callback once; the DOM string-handler overload is
    // irrelevant here, while Node's timer helper remains on the replacement.
    spyOn(globalThis, "setTimeout").mockImplementationOnce(shortTimer as typeof setTimeout);
    const fetcher = spyOn(globalThis, "fetch");
    if (stage === "session confirmation") fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    const stalledFetch = Object.assign(
      (_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      { preconnect: globalThis.fetch.preconnect },
    );
    fetcher.mockImplementationOnce(stalledFetch);
    expect(await signIn.email(input)).toEqual({
      error: { message: "Sign in timed out. Please try again." },
    });
    // A successful retry replaces the failed operation; no stale timeout or
    // failed session is allowed to turn its result into an error.
    fetcher.mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(
      Response.json({ email: input.email, name: null, expiresAt: "2099-01-01" }),
    );
    expect(await signIn.email(input)).toEqual({ error: null });
  });
});

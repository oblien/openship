import { describe, expect, it, vi, afterEach } from "vitest";
import { mailApi } from "./mail";
import { getApiErrorMessage, getApiErrorCode } from "./client";

/**
 * #492: `POST /mail/setup` answers with the SSE stream itself, so a 200 says
 * nothing about whether the install works — the only honest failure signal is a
 * non-2xx BEFORE the stream. `streamSetup` has to turn that into the same
 * `ApiError` the rest of the client raises, or the operator sees a JSON blob
 * (or, as reported, nothing at all).
 */
function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        statusText: status === 502 ? "Bad Gateway" : "Conflict",
      }),
    ),
  );
}

async function start() {
  return mailApi
    .streamSetup("srv_1", "example.com", undefined, { adminPassword: "x" }, () => {})
    .then(() => null as unknown as Error)
    .catch((err: unknown) => err as Error);
}

describe("mailApi.streamSetup — setup never started", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces the preflight's sentence and its code", async () => {
    respond(502, {
      error:
        "Can't start mail setup: Permission denied (publickey,password). Openship could not run a single command on this server.",
      code: "permission_denied",
    });

    const err = await start();
    expect(getApiErrorMessage(err)).toContain("Permission denied (publickey,password)");
    expect(getApiErrorCode(err)).toBe("permission_denied");
  });

  it("surfaces a 409 without printing raw JSON at the operator", async () => {
    respond(409, { error: "Setup already running" });

    const err = await start();
    expect(getApiErrorMessage(err)).toBe("Setup already running");
    expect(getApiErrorMessage(err)).not.toContain("{");
  });

  it("still fails loudly when the body is not JSON", async () => {
    respond(502, "<html>502 Bad Gateway</html>");

    const err = await start();
    expect(err).toBeInstanceOf(Error);
    expect(getApiErrorMessage(err)).toContain("502");
  });
});

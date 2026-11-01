import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ImapFlow } from "imapflow";
import { ImapTimeoutError, probeImap, withImap } from "../src/lib/imap";

const auth = { host: "mail.example.test", port: 993, user: "user@example.test", pass: "test-only" };
afterEach(() => mock.restore());

describe("IMAP credential verification", () => {
  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "ECONNRESET",
    "ETIMEDOUT",
    "CERT_HAS_EXPIRED",
  ])("preserves %s instead of reporting a bad password", async (code) => {
    const failure = Object.assign(new Error("Connection failed"), { code });
    spyOn(ImapFlow.prototype, "connect").mockRejectedValueOnce(failure);
    const closed = spyOn(ImapFlow.prototype, "close");
    await expect(probeImap(auth)).rejects.toBe(failure);
    expect(closed).toHaveBeenCalled();
  });

  it("returns false only for a credential rejection from the mail server", async () => {
    spyOn(ImapFlow.prototype, "connect").mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        responseStatus: "NO",
        serverResponseCode: "AUTHENTICATIONFAILED",
      }),
    );
    expect(await probeImap(auth)).toBe(false);
  });

  it.each(["UNAVAILABLE", "SERVERBUG", "PRIVACYREQUIRED"])(
    "preserves an authentication-stage %s failure",
    async (serverResponseCode) => {
      const failure = Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        responseStatus: "NO",
        serverResponseCode,
      });
      spyOn(ImapFlow.prototype, "connect").mockRejectedValueOnce(failure);
      await expect(probeImap(auth)).rejects.toBe(failure);
    },
  );

  it("does not treat a disconnect during AUTHENTICATE as rejected credentials", async () => {
    const failure = Object.assign(new Error("Connection not available"), {
      authenticationFailed: true,
      code: "NoConnection",
    });
    spyOn(ImapFlow.prototype, "connect").mockRejectedValueOnce(failure);
    await expect(probeImap(auth)).rejects.toBe(failure);
  });

  it("closes the connection when the operation fails", async () => {
    spyOn(ImapFlow.prototype, "connect").mockResolvedValueOnce(undefined);
    const closed = spyOn(ImapFlow.prototype, "close");
    const loggedOut = spyOn(ImapFlow.prototype, "logout").mockResolvedValue(undefined);
    const failure = new Error("Mailbox unavailable");
    await expect(
      withImap(auth, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(closed).toHaveBeenCalled();
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it("bounds a connection that never completes and closes it without waiting for LOGOUT", async () => {
    spyOn(ImapFlow.prototype, "connect").mockImplementationOnce(() => new Promise(() => {}));
    const closed = spyOn(ImapFlow.prototype, "close");
    const loggedOut = spyOn(ImapFlow.prototype, "logout");
    const operation = mock(async () => {});
    await expect(withImap(auth, operation, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      ImapTimeoutError,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it("propagates socket error events and tolerates a late error after cleanup", async () => {
    const failure = Object.assign(new Error("Socket closed"), { code: "ECONNRESET" });
    let connection!: ImapFlow;
    spyOn(ImapFlow.prototype, "connect").mockImplementationOnce(function (this: ImapFlow) {
      connection = this;
      queueMicrotask(() => this.emit("error", failure));
      return new Promise(() => {});
    });
    const closed = spyOn(ImapFlow.prototype, "close");
    await expect(probeImap(auth)).rejects.toBe(failure);
    expect(closed).toHaveBeenCalled();
    expect(() => connection.emit("error", failure)).not.toThrow();
  });
});

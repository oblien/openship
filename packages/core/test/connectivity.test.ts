import { describe, expect, it } from "vitest";

import { classifyConnectivityError, connFail, connOk } from "../src/connectivity";

describe("classifyConnectivityError", () => {
  it("maps refused / no-route / DNS errors to unreachable", () => {
    for (const m of [
      "connect ECONNREFUSED 1.2.3.4:22",
      "connection refused",
      "no route to host",
      "getaddrinfo ENOTFOUND host.invalid",
      "EHOSTUNREACH",
    ]) {
      expect(classifyConnectivityError(m).code).toBe("unreachable");
    }
  });

  it("maps auth failures to auth_failed", () => {
    for (const m of [
      "All configured authentication methods failed",
      "Permission denied (publickey)",
      "authentication failed",
    ]) {
      expect(classifyConnectivityError(m).code).toBe("auth_failed");
    }
  });

  it("maps filesystem permission errors to permission_denied, not auth_failed", () => {
    // Node spells EACCES as "EACCES: permission denied, <syscall> '<path>'".
    // The auth rule's bare "permission denied" token used to claim these, so an
    // operator with an unwritable backup destination was told their credentials
    // were rejected — sending them off to rotate SSH keys instead of chown'ing
    // the path. `access denied` / `read-only` already classified correctly, so
    // two ways of saying the same thing disagreed.
    for (const m of [
      "EACCES: permission denied, open '/backups/openship/db.sql'",
      "EACCES: permission denied, mkdir '/mnt/backup/nightly'",
      "EROFS: read-only file system, open '/srv/backups/x'",
    ]) {
      expect(classifyConnectivityError(m).code).toBe("permission_denied");
    }
  });

  it("still treats SSH permission denials as auth_failed", () => {
    // The errno rule must not swallow these — no EACCES/EROFS token present.
    expect(classifyConnectivityError("Permission denied (publickey)").code).toBe("auth_failed");
    expect(classifyConnectivityError("Permission denied, please try again").code).toBe(
      "auth_failed",
    );
  });

  it("maps deadline strings to timeout", () => {
    expect(classifyConnectivityError("operation timed out").code).toBe("timeout");
    expect(classifyConnectivityError("ETIMEDOUT").code).toBe("timeout");
  });

  it("maps handshake / channel / reset to protocol_error", () => {
    expect(classifyConnectivityError("Handshake failed").code).toBe("protocol_error");
    expect(classifyConnectivityError("Channel open failure: open failed").code).toBe("protocol_error");
  });

  it("honours an explicit tag over the message heuristics", () => {
    // Message looks unreachable, but the server tagged it as auth.
    expect(classifyConnectivityError("ECONNREFUSED", "auth_failed").code).toBe("auth_failed");
    expect(classifyConnectivityError("whatever", "no_server").code).toBe("misconfigured");
    expect(classifyConnectivityError("whatever", "connection_failed").code).toBe("unreachable");
  });

  it("accepts Error objects and unknown input", () => {
    expect(classifyConnectivityError(new Error("connection refused")).code).toBe("unreachable");
    expect(classifyConnectivityError("some novel failure").code).toBe("unknown");
    expect(classifyConnectivityError(undefined).message).toBe("Connection failed");
  });
});

describe("connOk / connFail", () => {
  it("connOk is reachable + ok, carrying latency when given", () => {
    expect(connOk()).toMatchObject({ ok: true, code: "reachable" });
    expect(connOk(42).latencyMs).toBe(42);
  });

  it("connFail carries the code and trims the message", () => {
    const r = connFail("timeout", "  slow  ");
    expect(r).toMatchObject({ ok: false, code: "timeout", message: "slow" });
    expect(connFail("unknown", "").message).toBe("Connection failed");
  });
});

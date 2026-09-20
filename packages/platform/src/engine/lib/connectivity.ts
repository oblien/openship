/**
 * Unified connectivity registry — the single place any feature asks "can we
 * reach / authenticate / use this target". A small registry (mirroring the
 * backup destination registry) maps a `kind` to a check returning the shared
 * `ConnectivityResult`. Adding a target (cluster node, networking endpoint,
 * mail server, new backup kind) is one `registerConnectivityCheck` call.
 *
 * This module is deliberately pure (only `@repo/core`) so it's trivially
 * testable and free of transport/env coupling. The built-in checks live in
 * `./connectivity-checks` and self-register when imported; callers that run
 * checks import that module for its side effect.
 */
import { classifyConnectivityError, connFail, type ConnectivityResult } from "@repo/core";

export type ConnectivityCheck<I> = (input: I) => Promise<ConnectivityResult>;

const registry = new Map<string, ConnectivityCheck<unknown>>();

/** Register a check for a target `kind`. Later registrations win (test hook). */
export function registerConnectivityCheck<I>(kind: string, fn: ConnectivityCheck<I>): void {
  registry.set(kind, fn as ConnectivityCheck<unknown>);
}

/**
 * Run the check for `kind` against `input`. Always resolves to a
 * `ConnectivityResult` — an unknown kind is `misconfigured`, and any escaped
 * throw is classified rather than propagated.
 */
export async function runConnectivityCheck<I = unknown>(
  kind: string,
  input: I,
): Promise<ConnectivityResult> {
  const check = registry.get(kind);
  if (!check) return connFail("misconfigured", `Unknown connectivity check: ${kind}`);
  try {
    return await check(input as unknown);
  } catch (err) {
    const { code, message } = classifyConnectivityError(err);
    return connFail(code, message);
  }
}

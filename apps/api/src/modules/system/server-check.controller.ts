/** HTTP adapters over shared server diagnostics, installers, prompts and streams. */
import type { Context } from "hono";
import { CreateServerInputSchema, parseInput } from "@repo/contracts";
import { env } from "@repo/platform/engine/config/index";
import { repos } from "@repo/db";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { runEphemeralConnectionTest } from "@repo/platform/engine/modules/system/server-check.operations";
import { operationContext, operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";
import { param } from "../../lib/controller-helpers";
import { isLocalBootstrapRequest } from "../../middleware/local-bootstrap";

const operations = () => getPlatformKernel().servers;
function connectionResponse(c: Context, result: { ok: boolean; message: string; code?: string }) {
  return c.json(result, result.ok ? 200 : result.code === "auth_failed" ? 400 : 502);
}
export async function testConnection(c: Context) {
  return connectionResponse(c, await operationData(c, operations().testConnection(operationContext(c), await c.req.json())));
}
export async function checkServer(c: Context) {
  const { serverId, ...input } = (await c.req.json()) ?? {};
  return c.json(await operationData(c, operations().check(operationContext(c), serverId, input)));
}
export async function installComponent(c: Context) {
  const { serverId, ...input } = (await c.req.json()) ?? {};
  return c.json(await operationData(c, operations().installComponent(operationContext(c), serverId, input)));
}
export async function removeComponent(c: Context) {
  const { serverId, ...input } = (await c.req.json()) ?? {};
  return c.json(await operationData(c, operations().removeComponent(operationContext(c), serverId, input)));
}
export async function scanExposedPorts(c: Context) {
  return c.json(await operationData(c, operations().scanPorts(operationContext(c), param(c, "id"))));
}
export async function installRespond(c: Context) {
  return c.json(await operationData(c, operations().respondToInstall(operationContext(c), await c.req.json())));
}
export async function getInstallSession(c: Context) {
  return c.json(await operationData(c, operations().getInstallSession(operationContext(c), { sessionId: c.req.query("id") })));
}
export async function installStream(c: Context) {
  const { serverId, ...input } = (await c.req.json()) ?? {};
  return operationEvents(c, signal => operations().openInstallStream(operationContext(c), serverId, input, { signal }));
}
export async function attachInstallStream(c: Context) {
  return operationEvents(c, signal => operations().openInstallEvents(operationContext(c), { sessionId: c.req.query("id") }, { signal }));
}
export async function monitorStream(c: Context) {
  return operationEvents(c, signal => operations().openMonitor(operationContext(c), c.req.query("serverId")!, { signal }));
}

// First-run admission remains an HTTP integration; the connection test itself is shared.
export async function onboardingTestConnection(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  // A publicly-served / CLI-managed instance is network-reachable, so an
  // UNauthenticated SSH prober here is an SSRF / port-scan oracle. Those
  // instances must be configured through the authenticated flow — disable the
  // pre-auth variant for them entirely.
  if (!isLocalBootstrapRequest(c)) {
    return c.json({ error: "Not available" }, 404);
  }

  const servers = await repos.server.list();
  if (servers.length > 0) {
    return c.json({ error: "Instance already configured" }, 403);
  }

  // Never let the pre-auth prober reach loopback / link-local / cloud-metadata
  // targets — never a legitimate remote SSH server, and the highest-value SSRF
  // targets (e.g. 169.254.169.254). Private LAN ranges stay allowed for the
  // authorized local operator; anonymous remote callers are rejected above.
  const body = await c.req.json().catch(() => ({}));
  if (isBlockedSshTarget(typeof body?.sshHost === "string" ? body.sshHost.trim() : "")) {
    return c.json({ ok: false, message: "This host is not allowed.", code: "blocked_host" }, 400);
  }

  return connectionResponse(c, await runEphemeralConnectionTest(parseInput(CreateServerInputSchema, body)));
}

/** Literal loopback / link-local / cloud-metadata / wildcard SSH targets. */
function isBlockedSshTarget(host: string): boolean {
  if (!host) return false; // empties handled by the normal validation
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (/^127\./.test(h)) return true; // IPv4 loopback
  if (/^169\.254\./.test(h)) return true; // IPv4 link-local + cloud metadata
  if (/^(fe80|fc|fd)/.test(h)) return true; // IPv6 link-local / ULA
  return false;
}

import { env } from "../config";

/** Loopback / non-routable "this machine" addresses — never a real remote SSH target. */
function isLoopbackAddress(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * True when a `servers` row actually denotes THIS control-plane host, even if its
 * `isLocal` flag was never set.
 *
 * On a self-hosted server-host the box is itself a deploy target. It's registered
 * once as the `isLocal` "This Server" row (self-server.ts), but an operator can
 * ALSO add it as a plain SSH row — onboarding (/system/setup) or Settings→Servers
 * default `isLocal:false` — pointing at loopback or the box's own public address.
 * Deploying to / probing such a row dials SSH to the API's own loopback (the
 * CONTAINER's, when compose-deployed via `openship up`) where there is no sshd —
 * the "Can't reach 127.0.0.1 … couldn't open an SSH connection to 127.0.0.1:22"
 * failure. These rows must resolve to the local host executor + mounted docker
 * socket (DooD), exactly like the isLocal row — never SSH.
 *
 * Scope: server-host only (DEPLOY_MODE docker|bare, not CLOUD_MODE). The SaaS
 * never treats a tenant's server row as the control plane, and the desktop app
 * targets its own machine through an explicit isLocal "This Machine" row.
 *
 * A row that is a deliberate SSH TUNNEL — a jump/bastion host set, or a loopback
 * host on a non-default port (the classic `ssh -L` local-forward-to-elsewhere
 * pattern) — is NOT this host and must keep dialing SSH. Those fields are checked,
 * so such a row is never hijacked to the local socket.
 */
export function resolvesToLocalHost(server: {
  sshHost?: string | null;
  sshPort?: number | null;
  sshJumpHost?: string | null;
}): boolean {
  if (env.CLOUD_MODE) return false;
  if (env.DEPLOY_MODE !== "docker" && env.DEPLOY_MODE !== "bare") return false;

  // A jump/bastion host means the row deliberately tunnels to a DIFFERENT machine
  // — never "this host", even if the entry point is loopback.
  if (server.sshJumpHost?.trim()) return false;

  const h = (server.sshHost ?? "").trim().toLowerCase();
  const port = server.sshPort ?? 22;

  // Loopback → this host, but only on the default SSH port: `127.0.0.1:<other>`
  // is an operator's local port-forward to somewhere else, not our own sshd.
  if (isLoopbackAddress(h)) return port === 22;

  // The box's own configured public IP (SERVER_IP) also means "this host". A
  // public IP uniquely identifies one interface, so a genuinely remote box can
  // never share it — collision-safe. HOST_DOMAIN is deliberately NOT matched
  // here: it's a subdomain-routing base domain whose apex is not guaranteed to
  // resolve to this box (e.g. *.acme.com → here, but acme.com → a different
  // server), so matching it could hijack a real remote deploy to the local socket.
  const selfIp = env.SERVER_IP?.trim().toLowerCase();
  return !!selfIp && h === selfIp;
}

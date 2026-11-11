import { env } from "@repo/platform/engine/config/env";

/** Website origins may submit public contact, without gaining access to cookie-authenticated APIs. */
export function publicContactOrigin(path: string, origin: string): boolean {
  return (
    env.CLOUD_MODE &&
    path === "/api/cloud/support" &&
    env.CONTACT_TURNSTILE_HOSTNAMES.split(",")
      .map((host) => `https://${host.trim()}`)
      .includes(origin)
  );
}

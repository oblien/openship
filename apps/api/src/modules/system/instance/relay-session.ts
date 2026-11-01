import { db, eq, schema } from "@repo/db";
import type { InstanceConnection } from "@repo/core";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { controllerConnection, type ControllerState } from "./controller-state";
import { deviceCookieName } from "./device-session";

export function remoteSessionHeaders(connection: InstanceConnection): Headers {
  const headers = new Headers();
  if (Object.keys(connection.cookies).length)
    headers.set(
      "cookie",
      Object.entries(connection.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    );
  return headers;
}

/** Apply only this fixed peer's auth-cookie changes. Lock and recheck the
 * installation generation: a late response must not reconnect a disconnected
 * device or overwrite the credentials of a newly selected instance. */
export async function saveRemoteCookies(state: ControllerState, headers: Headers): Promise<void> {
  const changes = headers.getSetCookie();
  if (!changes.length) return;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.instanceController)
      .where(eq(schema.instanceController.id, "local"))
      .for("update");
    if (
      !current ||
      current.revision !== state.revision ||
      !["connected", "retired"].includes(current.role)
    )
      return;
    const connection = controllerConnection(current),
      expected = controllerConnection(state);
    if (
      !connection ||
      connection.installationId !== expected?.installationId ||
      connection.origin !== expected.origin
    )
      return;
    const cookies = { ...connection.cookies };
    let changed = false;
    for (const line of changes) {
      const [pair, ...attributes] = line.split(";");
      const equals = pair!.indexOf("=");
      if (equals < 1) continue;
      const name = pair!.slice(0, equals).trim(),
        value = pair!.slice(equals + 1).trim();
      // Better Auth prefixes are fixed by Openship. Ignore arbitrary cookies
      // from a proxy/application sharing the public host.
      if (!deviceCookieName.test(name) || value.length > 16_384) continue;
      const expired =
        !value || attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
      if (expired) delete cookies[name];
      else cookies[name] = value;
      changed = true;
    }
    if (!changed || Object.keys(cookies).length > 32 || JSON.stringify(cookies).length > 64_000)
      return;
    await tx
      .update(schema.instanceController)
      .set({ connection: encrypt(JSON.stringify({ ...connection, cookies })) })
      .where(eq(schema.instanceController.id, "local"));
  });
}

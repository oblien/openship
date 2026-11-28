import { createHash, randomUUID } from "node:crypto";
import type { CommandExecutor } from "@repo/adapters";
import { AppError, shellQuote } from "@repo/core";
import { managedMailNamespacePattern } from "@repo/contracts/managed-mail";
import { patPrefix } from "../../../lib/pat";
import { sshManager } from "../../../lib/ssh-manager";
import { validateMailDomain } from "../mail-domain";
import {
  mailConfigFile,
  mailEngineCommand,
  requireMailEngine,
  resolveMailMutationAccess,
  writeMailConfigFile,
} from "../mail-engine";

const driver = "/opt/openship-mail/api-relay-config.py";
export type RelayInstallation = { binding: string; keyId: string };
type Authority = { apiOrigin: string; namespace: string };
type Credential = { key: string; keyId: string };

export function relayBinding({ apiOrigin, namespace }: Authority) {
  return createHash("sha256")
    .update(JSON.stringify([apiOrigin, namespace]))
    .digest("hex");
}

async function hasApiRelay(exec: CommandExecutor) {
  const { flavor } = await requireMailEngine(exec);
  if (flavor !== "container") return false;
  const probe = "test -r " + driver + " && echo ready || echo missing";
  return (
    (await exec.exec(mailEngineCommand(flavor, "sh -c " + shellQuote(probe)))).trim() === "ready"
  );
}

export function mailApiRelayAvailable(serverId: string) {
  return sshManager.withExecutor(serverId, hasApiRelay);
}

export async function mailApiRelay(
  serverId: string,
  domain: string,
  authority: Authority,
  change?: Credential | "remove",
): Promise<RelayInstallation | null> {
  domain = domain.trim().toLowerCase();
  validateMailDomain(domain);
  const origin = new URL(authority.apiOrigin);
  if (
    !managedMailNamespacePattern.test(authority.namespace) ||
    origin.origin !== authority.apiOrigin ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
  )
    throw new AppError("Invalid Cloud relay authority.", 400);
  if (typeof change === "object") {
    const prefix = patPrefix(change.key);
    if (!prefix || !/^[A-Za-z0-9_-]+$/.test(change.key.slice(prefix.length)))
      throw new AppError("A domain-scoped OpenShip send key is required.", 400);
  }
  const binding = relayBinding(authority);
  return sshManager.withExecutor(serverId, async (exec) => {
    if (!(await hasApiRelay(exec)))
      throw new AppError(
        "Update this server to the current OpenShip Mail container image to enable the API relay.",
        409,
      );
    const flavor = "container";
    const run = (cmd: string) => exec.exec(mailEngineCommand(flavor, cmd));
    const call = async (action: string, extra?: string): Promise<RelayInstallation | null> => {
      const metadata = JSON.parse(
        await run(
          ["python3", "-I", driver, action, domain, ...(extra ? [extra] : [])]
            .map(shellQuote)
            .join(" "),
        ),
      );
      if (metadata === null) return null;
      if (metadata.binding !== binding || typeof metadata.keyId !== "string")
        throw new AppError("This domain has a different Cloud relay connection.", 409);
      return { binding, keyId: metadata.keyId };
    };
    if (!change) return call("status");
    if (change === "remove") return call("remove", binding);
    const nonce = randomUUID();
    const staging = mailConfigFile(flavor, "saslPasswd").write + ".api-" + nonce;
    const { hostFiles } = await resolveMailMutationAccess(exec, flavor, [{ path: staging }]);
    await writeMailConfigFile(
      hostFiles,
      staging,
      JSON.stringify({ ...change, binding, domain, apiOrigin: origin.origin }),
      { mode: 0o600 },
    );
    try {
      return await call("install", nonce);
    } finally {
      await hostFiles.rm(staging);
    }
  });
}

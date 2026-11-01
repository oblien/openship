import { AppError } from "@repo/core";
import { createExecutor } from "@repo/adapters";
import { buildSshConfig, type SshSettingsInput } from "./ssh-manager";
import { validateSshConnectionOptions } from "./ssh-validation";

/** Same SSH adapter as connected servers; first successful authentication pins
 * the public host key. Saved sources check that key on every reconnect. */
export async function verifyCustomerSshConnection(
  input: SshSettingsInput,
  purpose: "deployment" | "migration_source" = "deployment",
  expectedHostKey?: string,
) {
  validateSshConnectionOptions(input);
  if (
    !input.sshHost ||
    input.sshKeyPath ||
    input.sshJumpHost ||
    input.sshArgs ||
    (input.sshTransport && input.sshTransport !== "direct") ||
    (input.sshAuthMethod !== "password" && input.sshAuthMethod !== "key")
  )
    throw new AppError(
      "Use direct SSH with a password or uploaded private key",
      400,
      "INVALID_MIGRATION_CONNECTION",
    );
  const settings = {
    purpose,
    sshHost: input.sshHost.trim(),
    sshHostKey: expectedHostKey,
    sshPort: input.sshPort ?? 22,
    sshUser: input.sshUser?.trim() || "root",
    sshAuthMethod: input.sshAuthMethod as "password" | "key",
    sshPassword: input.sshAuthMethod === "password" ? input.sshPassword : undefined,
    sshPrivateKey: input.sshAuthMethod === "key" ? input.sshPrivateKey : undefined,
    sshKeyPassphrase: input.sshAuthMethod === "key" ? input.sshKeyPassphrase : undefined,
  };
  let hostKey: string | undefined = expectedHostKey;
  const config = await buildSshConfig(settings, {
    trustOnFirstUse: (key) => {
      const value = key.toString("base64");
      hostKey ??= value;
      return value === hostKey;
    },
  });
  if (!config)
    throw new AppError(
      "Enter a password or upload the server's private SSH key",
      400,
      "INVALID_MIGRATION_CONNECTION",
    );
  const executor = createExecutor(config);
  try {
    await executor.exec("true", { timeout: 15_000 });
    if (!hostKey)
      throw new AppError(
        "The server did not provide an SSH host key",
        502,
        "MIGRATION_HOST_KEY_MISSING",
      );
    return { settings, hostKey };
  } finally {
    await executor.dispose();
  }
}

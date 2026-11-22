import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { AppError, assertLocalHostExecutionAllowed } from "@repo/core";

/** glab owns keyring access and refresh. Never include helper output in an error. */
export async function readLocalGlabToken(): Promise<string> {
  assertLocalHostExecutionAllowed();
  const env: NodeJS.ProcessEnv = {
    GITLAB_HOST: "gitlab.com",
    GITLAB_API_HOST: "gitlab.com",
    GLAB_API_PROTOCOL: "https",
  };
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "GLAB_CONFIG_DIR",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Electron and launchd often omit Homebrew from their inherited PATH.
  if (process.platform === "darwin")
    env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      .filter(Boolean)
      .join(":");
  const unavailable = () =>
    new AppError(
      "Sign in on the OpenShip controller with glab auth login --hostname gitlab.com, using a glab version with credential-helper support.",
      409,
      "GITLAB_CLI_UNAVAILABLE",
    );
  return new Promise((resolve, reject) => {
    execFile(
      "glab",
      ["auth", "credential-helper"],
      {
        cwd: homedir(),
        env,
        timeout: 15_000,
        maxBuffer: 32_768,
        windowsHide: true,
      },
      (err, stdout) => {
        if (!err) {
          try {
            const result = JSON.parse(stdout);
            const token = result.token?.token;
            if (
              result.type === "success" &&
              result.instance_url === "https://gitlab.com" &&
              typeof token === "string" &&
              token.length <= 16_384 &&
              /^\S+$/.test(token)
            ) {
              resolve(token);
              return;
            }
          } catch {
            // Older versions can print help instead of the JSON credential envelope.
          }
        }
        reject(unavailable());
      },
    );
  });
}

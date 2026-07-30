import type { CommandExecutor, LogEntry } from "../types";
import { sq } from "./local-shell";

// apt/dpkg non-interactive env, re-set INSIDE the sudo'd root shell. sudo
// resets the environment and many sudoers configs reject -E / --preserve-env,
// so exporting it here (rather than relying on the outer executor ENV_PREFIX,
// which runs before sudo) is what keeps apt from prompting under root.
const INSTALL_ENV = "DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew";

/** Wrap an arbitrary (possibly compound) command so it runs as root via
 *  passwordless sudo. `-n` fails fast instead of blocking on a password. */
export function elevateCommand(command: string): string {
  return `sudo -n sh -c ${sq(`export ${INSTALL_ENV}; ${command}`)}`;
}

/** Parent directory of an absolute path (for `mkdir -p` before a move). */
function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return ".";
  return idx === 0 ? "/" : path.slice(0, idx);
}

/**
 * Decorate a CommandExecutor so every privileged operation runs through
 * `sudo -n`. Construct this ONLY for a target that is non-root WITH passwordless
 * sudo (environment.ts `canSudo`) — it elevates unconditionally.
 *
 * Overrides just the mutating methods the component install/remove path uses
 * (exec, streamExec, writeFile, rename, mkdir, rm). Reads and transfers pass straight
 * through to the inner executor — files under /etc are world-readable and the
 * install path never transfers into a privileged path — keeping the sudo
 * surface minimal. A Proxy forwards every other (optional) executor method
 * (rawExec, forwardPort, openShell, onDisconnect, …) transparently.
 */
export function elevatedExecutor(inner: CommandExecutor): CommandExecutor {
  const writeFileElevated = async (path: string, content: string): Promise<void> => {
    // Stage into a user-writable temp, then move into place as root — avoids
    // piping large config/Lua content through the command line.
    const tmp = `/tmp/.openship-elev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await inner.writeFile(tmp, content);
    await inner.exec(
      elevateCommand(`mkdir -p ${sq(dirOf(path))} && mv -f ${sq(tmp)} ${sq(path)}`),
    );
  };

  const overrides: Partial<CommandExecutor> = {
    exec: (command: string, opts?: { timeout?: number }) =>
      inner.exec(elevateCommand(command), opts),
    streamExec: (command: string, onLog: (log: LogEntry) => void) =>
      inner.streamExec(elevateCommand(command), onLog),
    writeFile: writeFileElevated,
    // Elevated for the same reason as writeFile: the vhost/conf dirs are root-owned,
    // and the Proxy would otherwise forward this to the inner executor unelevated —
    // EACCES immediately after an elevated write succeeded.
    rename: async (from: string, to: string) => {
      await inner.exec(elevateCommand(`mv -f ${sq(from)} ${sq(to)}`));
    },
    mkdir: async (path: string) => {
      await inner.exec(elevateCommand(`mkdir -p ${sq(path)}`));
    },
    rm: async (path: string) => {
      await inner.exec(elevateCommand(`rm -rf ${sq(path)}`));
    },
  };

  return new Proxy(inner, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return (overrides as Record<string | symbol, unknown>)[prop];
      }
      // Bind to the REAL inner (not the proxy) so delegated methods never
      // re-enter the elevation layer.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

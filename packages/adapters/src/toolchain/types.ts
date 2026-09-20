/**
 * Toolchain types - stack-level tool validation and installation.
 *
 * The toolchain layer ensures a bare-metal server has the right
 * language runtimes installed BEFORE a build starts. It mirrors
 * the system component catalog (Docker/Nginx/Git) but for
 * language-specific tools (Node, Go, Rust, Python, etc.).
 *
 * The source of truth for WHICH tools a language needs lives in
 * `@repo/core` → `LANGUAGES[lang].requiredTools`. This layer
 * provides HOW to check and install them.
 */

import type { Answer } from "@repo/core";

// ─── Tool status ─────────────────────────────────────────────────────────────

export interface ToolchainStatus {
  /** Tool identifier (e.g. "node", "go", "rustc") */
  name: string;
  /** Human-readable label (e.g. "Node.js", "Go", "Rust compiler") */
  label: string;
  /** Whether the tool is installed and available */
  installed: boolean;
  /** Detected version string */
  version?: string;
  /** Minimum required version for this stack/toolchain check */
  requiredVersion?: string;
  /** Ready to use */
  healthy: boolean;
  /** Human-readable status message */
  message: string;
}

// ─── Aggregate result ────────────────────────────────────────────────────────

export interface ToolchainCheckResult {
  /** Status of each required tool */
  tools: ToolchainStatus[];
  /** All tools present and healthy */
  ready: boolean;
  /** Names of missing tools */
  missing: string[];
  /** Names of installed but too-old tools */
  outdated: string[];
}

// ─── Catalog entry types ─────────────────────────────────────────────────────

/** Recipe for checking whether a tool is installed. */
export interface ToolchainCheckEntry {
  /** Human-readable label */
  label: string;
  /** Shell command to detect the tool + version */
  versionCommand: string;
  /** Extract a clean version string from command output */
  parseVersion: (output: string) => string;
  /** Message when the tool is not found */
  missingMessage: string;
  /**
   * Whether this tool can be auto-installed.
   * Some tools (npm, cargo, mix) ship with their parent - no separate install.
   */
  installable: boolean;
  /** Parent tool that provides this one (e.g. "npm" → "node") */
  providedBy?: string;
}

/** Who has to run an install step. */
export type ToolStepUser = "login" | "root";

/** One install step, and the authority it needs. */
export interface ToolStep {
  readonly command: string;
  /**
   * The asymmetry between the two is deliberate and load-bearing.
   *
   * `"root"` is a *requirement subject to host policy*: it writes host-wide (a package
   * manager lock, /usr/local, a unit file), so it is elevated wherever the host requires
   * elevation — and on macOS it deliberately isn't, because Homebrew refuses to run
   * under sudo.
   *
   * `"login"` is a *hard constraint*: the step lands inside the SSH login user's own
   * home, so it must never be elevated. Running it as root produces the worst kind of
   * green install — sudo rewrites HOME, root creates `~/.bun` / `~/.cargo` / `~/.rustup`,
   * `verify` passes because it only reads, and then the build's first write into that
   * tree fails EACCES with nothing pointing at the cause.
   */
  readonly as: ToolStepUser;
}

/** How to install one tool on one host. */
export interface ToolInstall {
  /**
   * Ordered steps. Consecutive steps sharing an authority run as one `&&`-joined script,
   * so the 13 uniform recipes stay a single round-trip.
   *
   * A list of labelled steps rather than one command plus one `privileged` flag: a single
   * flag cannot describe bun or rustc, which download into the login user's home and then
   * link the result into /usr/local/bin. One flag forced both halves to the same
   * authority, and whichever way it was set, one half was wrong.
   */
  readonly steps: readonly ToolStep[];
  /** Proves the tool is on PATH afterwards, and yields a version to parse. Runs as the
   *  LOGIN user, unelevated — the tool has to work for whoever builds with it. */
  readonly verifyCommand: string;
}

/**
 * An install command for this host, or the reason there isn't one.
 *
 * Same two-arm shape as the system catalog's `InstallPlan`. `startCommand` and
 * `fallbackInstallCommands` are gone: no factory ever set either, so the installer's
 * handling for them was unreachable — a language runtime is a binary, not a daemon.
 */
export type ToolchainInstallPlan = Answer<ToolInstall>;

// ─── Install result ──────────────────────────────────────────────────────────

export interface ToolchainInstallResult {
  tool: string;
  success: boolean;
  version?: string;
  error?: string;
}

/**
 * Toolchain types — stack-level tool validation and installation.
 *
 * The toolchain layer ensures a bare-metal server has the right
 * language runtimes installed BEFORE a build starts. It mirrors
 * the system component catalog (Docker/Traefik/Git) but for
 * language-specific tools (Node, Go, Rust, Python, etc.).
 *
 * The source of truth for WHICH tools a language needs lives in
 * `@repo/core` → `LANGUAGES[lang].requiredTools`. This layer
 * provides HOW to check and install them.
 */

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
   * Some tools (npm, cargo, mix) ship with their parent — no separate install.
   */
  installable: boolean;
  /** Parent tool that provides this one (e.g. "npm" → "node") */
  providedBy?: string;
}

/** Plan for installing a tool — same shape as system catalog. */
export interface ToolchainInstallPlan {
  supported: boolean;
  unsupportedReason?: string;
  installCommand?: string;
  startCommand?: string;
  verifyCommand?: string;
  fallbackInstallCommands?: string[];
}

// ─── Install result ──────────────────────────────────────────────────────────

export interface ToolchainInstallResult {
  tool: string;
  success: boolean;
  version?: string;
  error?: string;
}

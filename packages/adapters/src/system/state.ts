/**
 * Setup state persistence — avoids running system checks on every operation.
 *
 * The system layer checks whether Docker, Nginx, Git, etc. are installed.
 * Running these checks on every deploy/build request is wasteful. Instead,
 * we store the setup state and only re-check when:
 *   - First boot (no state exists)
 *   - User explicitly requests a re-check
 *   - A component operation fails (invalidates cached state)
 *
 * Architecture:
 *   SetupStateStore is an INTERFACE so the API layer can provide a
 *   DB-backed implementation. The default FileStateStore writes to disk
 *   as a fallback for environments without a database.
 */

import type { CommandExecutor } from "../types";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Stored per-component state */
export interface ComponentState {
  installed: boolean;
  version?: string;
  running?: boolean;
  healthy?: boolean;
  installedAt?: string;
}

/** Full setup state — persisted between restarts */
export interface SetupState {
  /** Whether the initial setup flow has been completed */
  setupComplete: boolean;
  /** Runtime mode when setup was performed */
  mode: "docker" | "bare";
  /** Per-component state keyed by name */
  components: Record<string, ComponentState>;
  /**
   * ISO timestamp of last full verification.
   * Used to decide if we should re-verify (e.g. after 24h).
   */
  lastVerifiedAt?: string;
  /** ISO timestamp of last state update */
  updatedAt: string;
}

/**
 * Interface for persisting setup state.
 *
 * The API layer provides a DB-backed implementation.
 * FileStateStore is the built-in fallback.
 */
export interface SetupStateStore {
  get(): Promise<SetupState | null>;
  set(state: SetupState): Promise<void>;
  clear(): Promise<void>;
}

// ─── File-based state store ──────────────────────────────────────────────────

const DEFAULT_STATE_PATH = "/etc/openship/setup-state.json";

/**
 * Persists setup state to a JSON file.
 *
 * Works both locally (node:fs) and remotely (via CommandExecutor) so the
 * same store works regardless of whether the server is local or SSH.
 */
export class FileStateStore implements SetupStateStore {
  private readonly statePath: string;
  private readonly executor: CommandExecutor;

  constructor(executor: CommandExecutor, statePath?: string) {
    this.executor = executor;
    this.statePath = statePath ?? DEFAULT_STATE_PATH;
  }

  async get(): Promise<SetupState | null> {
    try {
      const exists = await this.executor.exists(this.statePath);
      if (!exists) return null;

      const content = await this.executor.readFile(this.statePath);
      return JSON.parse(content) as SetupState;
    } catch {
      return null;
    }
  }

  async set(state: SetupState): Promise<void> {
    const content = JSON.stringify(state, null, 2);
    await this.executor.writeFile(this.statePath, content);
  }

  async clear(): Promise<void> {
    await this.executor.rm(this.statePath);
  }
}

/**
 * Single source of truth for the CLI's on-disk home.
 *
 * Everything the CLI persists — the PGlite data dir, logs, the internal/auth
 * tokens, ports.json, config.json, the compose stack, the dashboard cache — lives
 * under OS_DIR. It defaults to ~/.openship but is overridable via OPENSHIP_HOME
 * so a FROM-SOURCE ("dev") install can run fully isolated from a production
 * install: separate data dir (concurrent PGlite opens on the same dir corrupt
 * it), separate ports, tokens, config, and — via IS_ALT_HOME — a separate boot
 * service. The from-source launcher (scripts/install-source.sh) sets
 * OPENSHIP_HOME=~/.openship-dev.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_HOME = join(homedir(), ".openship");

const override = process.env.OPENSHIP_HOME?.trim();
export const OS_DIR = override ? resolve(override) : DEFAULT_HOME;

/** True when running against a non-default home (a from-source/dev install). */
export const IS_ALT_HOME = OS_DIR !== DEFAULT_HOME;

/**
 * State under OS_DIR that more than one module has to name.
 *
 * `join(OS_DIR, "data")` and `join(OS_DIR, "logs")` were each spelled out in two
 * modules already, and `up --dry-run` (which lists what a real run would write)
 * would have made a third copy of each — a preview whose paths are re-derived is
 * one rename away from naming files the install doesn't touch.
 */
export const DATA_DIR = join(OS_DIR, "data");
export const LOG_DIR = join(OS_DIR, "logs");
export const AUTH_SECRET_FILE = join(OS_DIR, "auth-secret");
export const INTERNAL_TOKEN_FILE = join(OS_DIR, "internal-token");

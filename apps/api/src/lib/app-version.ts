import apiPackage from "../../package.json";

/**
 * The running self-hosted app version, from `apps/api/package.json`. Single
 * source of truth — surfaced by `/api/health` and sent to Openship Cloud on
 * every self-hosted → SaaS request (see the version header below).
 *
 * Desktop reports this same API version; the dashboard shell separately knows
 * its own bundle version via `window.desktop.app.version()`.
 */
export const APP_VERSION: string = apiPackage.version;

/**
 * Header carrying `APP_VERSION` on every self-hosted → SaaS call (set in
 * `cloud/transport.ts`). The cloud reads it to gate behavior when an instance
 * is outdated (deprecate old wire formats, nudge upgrades, block incompatible
 * clients, etc.). Lowercase because Hono normalizes header names on read.
 */
export const OPENSHIP_VERSION_HEADER = "x-openship-version";

/**
 * Companion header naming the caller's deploy platform (docker / bare /
 * desktop). Lets the cloud target update guidance by install type — a desktop
 * app and a server install update through different channels.
 */
export const OPENSHIP_PLATFORM_HEADER = "x-openship-platform";

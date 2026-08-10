/**
 * @module github.capabilities
 *
 * "What ways of connecting GitHub exist on THIS install, and which are set up?"
 * — answered once, on the server, from the same `CHAINS` table that resolves
 * credentials.
 *
 * Why this exists: the dashboard used to answer it itself. `ConnectPrompt` branched
 * on `selfHosted`, the settings chooser hardcoded which rows to render and gated
 * the App row on `cloudConnected`, and the forwarding toggle branched on
 * `deployMode === "desktop"`. That is the platform policy living in two places —
 * exactly the duplication the credential-chain refactor removed on the backend —
 * and the two drifted in ways users saw: a "Forward my git identity" checkbox that
 * could never take effect on self-hosted, and a chooser offering the Cloud App on a
 * box that had no cloud link.
 *
 * Now the client renders whatever this returns. Adding a credential kind means
 * adding it to `CHAINS` and describing it here; no dashboard change, and no way for
 * the UI to advertise something the resolver would refuse.
 *
 * NOTE ON `configured`: this reports whether a credential is PRESENT, never its
 * value. Nothing secret crosses this boundary.
 */

import { env } from "../../config/env";
import type { RequestContext } from "../../lib/request-context";
import { CHAINS, type GitHubTokenSource } from "./github.token";
import { repos } from "@repo/db";

/**
 * A way to connect, as the UI needs to reason about it.
 *
 * `kind` is deliberately NOT `GitHubTokenSource`: two of these (`ssh-key`,
 * `forwarding`) are not credentials the token chain resolves at all — they're
 * clone-transport options — and one credential (`user-oauth`) is never something
 * the operator picks directly. The UI vocabulary and the resolver vocabulary
 * overlap without being the same set, so they stay separate types.
 */
export type GitHubMethodKind =
  | "device"      // browser device sign-in (instance-wide git identity)
  | "token"       // pasted PAT (same slot as `device`)
  | "app"         // Openship Cloud GitHub App installation
  | "ssh-key"     // per-server deploy key — clone transport, not a token
  | "forwarding"; // desktop SSH relay of the operator's identity

export interface GitHubMethod {
  kind: GitHubMethodKind;
  /** Offerable on this install at all. `false` → the UI must not render it. */
  available: boolean;
  /** Already set up. Drives "Connected" vs "Set up" affordances. */
  configured: boolean;
  /**
   * Needs an Openship Cloud link before it can work. The App's private key lives
   * in openship.io, so a self-hosted instance proxies through it — the UI turns
   * this row's action into "Connect Openship Cloud" rather than showing a button
   * that 403s.
   */
  requiresCloud?: boolean;
  /** Present when `available` is false, so the UI can explain rather than hide. */
  unavailableReason?: string;
}

export interface GitHubCapabilities {
  /** "saas" | "selfhosted" — which column of CHAINS applies. */
  platform: "saas" | "selfhosted";
  /** True for the desktop app (the only place the identity relay applies). */
  desktop: boolean;
  /** The recommended method to lead with, or null when nothing is offerable. */
  primary: GitHubMethodKind | null;
  methods: GitHubMethod[];
}

/** Does the token chain for this platform contain a given credential at all? */
function chainHas(platform: "saas" | "selfhosted", kind: GitHubTokenSource): boolean {
  const chains = CHAINS[platform];
  return chains.local.includes(kind) || chains.remote.includes(kind);
}

/**
 * Resolve the connect methods for this install.
 *
 * `cloudConnected` is passed in rather than probed here: the caller already knows
 * it (the status handler resolves it for other reasons) and probing the SaaS from
 * inside a capability lookup would make a cheap read a network call.
 */
export async function resolveGitHubCapabilities(
  ctx: RequestContext,
  opts: { cloudConnected: boolean },
): Promise<GitHubCapabilities> {
  const platform: "saas" | "selfhosted" = env.CLOUD_MODE ? "saas" : "selfhosted";
  const desktop = env.DEPLOY_MODE === "desktop";

  // The instance-wide git identity (device sign-in / pasted token) occupies ONE
  // storage slot, so "configured" is the same fact for both rows — they differ only
  // in how you'd establish it.
  const settings = await repos.instanceSettings.get().catch(() => null);
  const identityConfigured = Boolean(settings?.ghDeviceTokenEncrypted);
  const identityMethod = settings?.ghDeviceTokenMethod ?? null;

  // `gh-cli` in the chain is what carries the instance identity, so its presence
  // there is the real test of whether these two rows can work at all — not a
  // mode string the UI guessed at.
  const identityUsable = chainHas(platform, "gh-cli");

  // Device sign-in additionally needs a client id to exist. Without one the
  // backend answers `flow: "token"`, so offering the device row would be a button
  // that turns into a different flow — say so instead.
  const { resolveDeviceClientId } = await import("./github.local-auth");
  const hasDeviceClientId = !env.CLOUD_MODE && resolveDeviceClientId() !== null;

  const methods: GitHubMethod[] = [
    {
      kind: "device",
      available: identityUsable && hasDeviceClientId,
      configured: identityConfigured && identityMethod === "device",
      unavailableReason: !identityUsable
        ? "Not available on Openship Cloud."
        : !hasDeviceClientId
          ? "This instance has no GitHub device client id configured."
          : undefined,
    },
    {
      kind: "token",
      available: identityUsable,
      configured: identityConfigured && identityMethod !== "device",
      unavailableReason: identityUsable ? undefined : "Not available on Openship Cloud.",
    },
    {
      kind: "app",
      available: chainHas(platform, "app-installation"),
      configured: opts.cloudConnected,
      // Only self-hosted proxies through the cloud; on the SaaS the App is native.
      requiresCloud: platform === "selfhosted",
    },
    {
      kind: "ssh-key",
      // Per-server deploy keys are a self-hosted/desktop concept: the SaaS has no
      // operator-owned servers to attach one to.
      available: platform === "selfhosted",
      configured: false, // per-server state; the Servers page owns the detail
      unavailableReason:
        platform === "selfhosted" ? undefined : "Openship Cloud manages build hosts for you.",
    },
    {
      kind: "forwarding",
      // DESKTOP ONLY, and this is the single source of that rule for the UI.
      // `relayConfigEligible` (deployments/clone-plan.ts) hard-requires isDesktop
      // because the relay vends the operator's account-wide token over the SSH
      // tunnel — a trust boundary a shared self-hosted box does not have.
      available: desktop,
      configured: false, // per-user preference; CloneCredentials owns the toggle
      unavailableReason: desktop
        ? undefined
        : "Identity forwarding is a desktop feature. Remote builds on a server use that server's own credential.",
    },
  ];

  // Lead with what needs the least setup and works here. Device sign-in when it's
  // possible, else the token paste, else the App.
  const primary: GitHubMethodKind | null =
    methods.find((m) => m.kind === "device" && m.available)?.kind ??
    methods.find((m) => m.kind === "token" && m.available)?.kind ??
    methods.find((m) => m.kind === "app" && m.available)?.kind ??
    null;

  return { platform, desktop, primary, methods };
}

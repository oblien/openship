"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Unified clone-credential modal.
 *
 * Shown whenever a deploy needs the user to pick HOW the repo gets cloned
 * onto the build worker — same decision for self-hosted server and
 * Openship Cloud, so one modal handles both. Replaces the previous split
 * between `CloneStrategyModalContent` (preemptive gate) and
 * `CloneCredentialMissingModal` (post-failure recovery).
 *
 * Up to four options are surfaced, conditionally:
 *
 *   1. Install Openship App on {owner}             — recommended, short-lived
 *                                                    repo-scoped tokens. Works
 *                                                    for buildStrategy=local
 *                                                    AND remote. Shown when
 *                                                    installUrl is available.
 *
 *   1b. Connect GitHub on this server              — per-server credential
 *                                                    (device login / PAT / SSH).
 *                                                    The server clones itself,
 *                                                    no cloud round-trip. Shown
 *                                                    for a self-hosted server
 *                                                    target (serverId present).
 *
 *   2. Add / Use a project clone token             — fine-grained PAT. Works
 *                                                    for both buildStrategy
 *                                                    modes. Shown when a
 *                                                    projectId is available.
 *
 *   3. Build on this machine, ship the artifact    — flips buildStrategy to
 *                                                    "local". Token stays on
 *                                                    the API host. The
 *                                                    resolver picks whatever
 *                                                    local credential exists
 *                                                    (project PAT, gh CLI,
 *                                                    App installation, OAuth).
 *                                                    Sub-line mentions the gh
 *                                                    CLI login explicitly when
 *                                                    it's available. Shown
 *                                                    when buildStrategy is
 *                                                    not already "local".
 *
 * NOTE: a separate "Use my GitHub session" option used to exist but was
 * removed — it was a duplicate of option 3 (both flip buildStrategy=local
 * and the resolver includes gh CLI). Promoting gh CLI to a remote-clone
 * path with a "danger flag" was considered and rejected: gh CLI is a
 * long-lived, broad-scope user PAT and shipping it off-host is a real
 * security hole (see github.token.ts purpose="remote" refusal).
 *
 * Trigger contexts:
 *   - "preflight-gate"     — preemptive on Deploy click (no failure yet),
 *                            persists the choice on userSettings.
 *                            cloneStrategyPreference so we stop asking.
 *   - "preflight-fail"     — caught in startDeployment after buildAccess
 *                            threw GITHUB_REMOTE_TOKEN_REQUIRED etc.
 *   - "build-fail"         — during the build SSE: deploy already started,
 *                            backend ran out of credentials mid-stream.
 *
 * The caller wires the Choice → action mapping. The modal itself owns the
 * install popup, the settings deep-link, and the preference persistence.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/context/ToastContext";
import { openAuthWindow } from "@/utils/authWindow";
import { settingsApi, type CloneStrategyPreference } from "@/lib/api";

/** What the user picked. The caller decides what to do with each. */
export type DeployCredentialChoice =
  | { kind: "install-app" }
  | { kind: "add-token" }
  | { kind: "build-local" }
  | { kind: "connect-server-github" }
  | { kind: "dismiss" };

export interface DeployCredentialModalProps {
  /**
   * Why is this modal open?
   * - preflight-gate: deploy is paused awaiting the choice (no failure)
   * - preflight-fail: deploy attempt already failed at buildAccess preflight
   * - build-fail:     deploy already started; build pipeline failed
   */
  trigger: "preflight-gate" | "preflight-fail" | "build-fail";

  /** Repo owner. Used in copy + as the App install target. */
  owner: string;
  /** URL to install the Openship App on this owner. Null if unavailable
   *  (e.g. no cloud connection yet on self-hosted). */
  installUrl: string | null;
  /** Project id — required for the "add a project clone token" option. */
  projectId: string | null;
  /** Target server id (self-hosted server deploys only). When present, the
   *  "Connect GitHub on this server" option is offered — it deep-links to the
   *  server's Security tab where the per-server credential is configured. */
  serverId?: string | null;
  /** Where is the deploy headed? Affects copy. */
  deployTarget: "local" | "server" | "cloud" | "cluster" | null | undefined;
  /** Current build strategy. We hide "Build locally" when it's already
   *  local (would be a no-op). */
  buildStrategy: "local" | "server" | null | undefined;
  /** Is this dashboard talking to a self-hosted API? Drives the
   *  copy hint on the "Build locally" option — when gh CLI is logged in,
   *  the sub-line mentions it explicitly so the user knows their session
   *  will be used. */
  selfHosted: boolean;
  /** Is gh CLI currently authenticated on the API host? Used to refine
   *  the "Build locally" copy; the resolver picks gh CLI automatically
   *  when buildStrategy=local on self-hosted. */
  ghCliAvailable: boolean;
  /** Whether the user has already saved a global PAT. Tweaks copy on
   *  the "Add a project clone token" option. */
  hasGlobalToken?: boolean;

  /**
   * Called when the user picks an option that needs the parent to do
   * something (build-local → flip config; install-app → retry deploy
   * after popup closes). The modal handles its own side-effects (popup
   * launch, navigate-to-settings, preference persistence) — onChoice is
   * for caller-owned state mutations.
   */
  onChoice: (choice: DeployCredentialChoice) => void;
  /** Close the modal. */
  onDismiss: () => void;
}

export function DeployCredentialModal({
  trigger,
  owner,
  installUrl,
  projectId,
  serverId,
  deployTarget,
  buildStrategy,
  selfHosted,
  ghCliAvailable,
  hasGlobalToken = false,
  onChoice,
  onDismiss,
}: DeployCredentialModalProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState<DeployCredentialChoice["kind"] | null>(null);

  // Preference persistence — only for the preemptive gate trigger. Maps
  // each unified choice back to the old CloneStrategyPreference values so
  // the gate keeps working unchanged.
  const persistPreferenceForGate = useCallback(
    async (pref: CloneStrategyPreference) => {
      if (trigger !== "preflight-gate") return;
      try {
        await settingsApi.updateCloneStrategyPreference(pref);
      } catch {
        // Silent — non-fatal, the deploy can still proceed without it.
      }
    },
    [trigger],
  );

  const handleInstallApp = useCallback(() => {
    if (!installUrl) {
      showToast(
        "Install URL is not available — connect Openship Cloud first.",
        "error",
        "GitHub App",
      );
      return;
    }
    setBusy("install-app");
    const handle = openAuthWindow();
    handle.navigate(installUrl);
    handle.onClose(() => {
      setBusy(null);
      // Don't persist a preference here — the user still needs to actually
      // complete the install; preference would lock them in even if they
      // cancel.
      onChoice({ kind: "install-app" });
    });
  }, [installUrl, onChoice, showToast]);

  const handleAddToken = useCallback(async () => {
    if (!projectId) {
      showToast(
        "Couldn't find this project to attach a token.",
        "error",
        "Clone token",
      );
      return;
    }
    setBusy("add-token");
    await persistPreferenceForGate("remote-with-token");
    router.push(`/projects/${projectId}?tab=git#clone-token`);
    onChoice({ kind: "add-token" });
  }, [projectId, onChoice, persistPreferenceForGate, router, showToast]);

  const handleConnectServerGithub = useCallback(() => {
    if (!serverId) return;
    setBusy("connect-server-github");
    // The parent opens the shared per-server connect model (same component as
    // the server's GitHub tab) and owns the post-connect retry, so the flow is
    // identical everywhere it appears.
    onChoice({ kind: "connect-server-github" });
  }, [serverId, onChoice]);

  const handleBuildLocal = useCallback(async () => {
    setBusy("build-local");
    await persistPreferenceForGate("local");
    showToast(
      "We'll build on this machine and ship the artifact",
      "success",
      "Clone strategy",
    );
    onChoice({ kind: "build-local" });
  }, [onChoice, persistPreferenceForGate, showToast]);

  // ── Visibility gates ───────────────────────────────────────────────
  const targetIsRemote = deployTarget === "server" || deployTarget === "cloud";
  const showInstallApp = !!installUrl;
  // Per-server GitHub — self-hosted server target only (cloud is App-token
  // only). Deep-links to the server's own credential setup, the tightest path
  // when the App/cloud round-trip isn't wanted.
  const showConnectServer = deployTarget === "server" && !!serverId;
  const showAddToken = !!projectId;
  // "Build locally" makes no sense for a local target (clone is already
  // local) or when buildStrategy is already local. Otherwise show it for
  // both server AND cloud targets — the cloud runtime supports local-build
  // + artifact upload via CloudRuntime.build.
  const showBuildLocal = targetIsRemote && buildStrategy !== "local";
  // Used in the build-local sub-copy to acknowledge the gh CLI session
  // explicitly when it's logged in — clarifies that picking "build
  // locally" will use the user's existing gh session as one of the
  // possible credentials (no separate option needed).
  const ghCliMentioned = selfHosted && ghCliAvailable && targetIsRemote;

  // ── Copy ───────────────────────────────────────────────────────────
  const targetLabel =
    deployTarget === "cloud" ? "Openship Cloud" : "your server";
  const headline =
    trigger === "preflight-gate"
      ? `How should we clone ${owner} on the build worker?`
      : `We can't clone this repo onto ${targetLabel}`;
  const subhead =
    trigger === "preflight-gate"
      ? `You're deploying to ${targetLabel}. Pick once and we'll stop asking — change it later in Settings.`
      : `The deploy needs a credential to read ${owner} remotely, and right now none is available. Pick how you'd like to unblock it — the deploy will retry automatically.`;

  return (
    <div className="p-6 space-y-5">
      <div className="space-y-2">
        <h3
          className="text-2xl font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          {headline}
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {subhead}
        </p>
      </div>

      <div className="space-y-2">
        {showInstallApp && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleInstallApp}
            className="w-full rounded-xl border border-border/50 bg-card p-4 text-start transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {busy === "install-app" ? (
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                ) : (
                  <UiIcon name="github" className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    Install the Openship GitHub App on {owner}
                  </p>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                    Recommended
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                  Short-lived, repo-scoped tokens minted on every deploy. No
                  long-lived PATs to manage, safe to ship to remote workers.
                </p>
              </div>
              <UiIcon name="external-link" className="size-4 text-muted-foreground shrink-0" />
            </div>
          </button>
        )}

        {showConnectServer && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleConnectServerGithub}
            className="w-full rounded-xl border border-border/50 bg-card p-4 text-start transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                {busy === "connect-server-github" ? (
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                ) : (
                  <UiIcon name="server" className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  Connect GitHub on this server
                </p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                  Authenticate this server to GitHub directly — device login, a
                  token, or an SSH key. The server clones on its own, no cloud
                  round-trip. Best when you deploy here often.
                </p>
              </div>
              <UiIcon name="external-link" className="size-4 text-muted-foreground shrink-0" />
            </div>
          </button>
        )}

        {showAddToken && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleAddToken}
            className="w-full rounded-xl border border-border/50 bg-card p-4 text-start transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                {busy === "add-token" ? (
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                ) : (
                  <UiIcon name="key" className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {hasGlobalToken
                    ? "Use my saved clone token"
                    : "Add a project clone token"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                  {hasGlobalToken
                    ? "Use the global PAT you've already saved — scoped narrower than your GitHub session."
                    : "Paste a fine-grained PAT scoped to this repo. You control the scope and expiry — Openship just uses it for clones."}
                </p>
              </div>
            </div>
          </button>
        )}

        {showBuildLocal && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleBuildLocal}
            className="w-full rounded-xl border border-border/50 bg-card p-4 text-start transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                {busy === "build-local" ? (
                  <UiIcon name="spinner" className="size-4 animate-spin" />
                ) : (
                  <UiIcon name="hard-drive" className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  Build on this machine, ship the artifact
                </p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                  {ghCliMentioned
                    ? `Clone + build runs on the API host using your gh CLI session (or project PAT / App / OAuth if available). Only the build output ships to ${targetLabel} — the token never leaves.`
                    : `Clone + build runs on the API host using whatever credential is available locally. Only the build output ships to ${targetLabel} — the token never leaves.`}
                </p>
              </div>
            </div>
          </button>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-border/40 -mx-6 px-6 -mb-6 pb-6">
        <button
          type="button"
          onClick={() => {
            onChoice({ kind: "dismiss" });
            onDismiss();
          }}
          disabled={busy !== null}
          className="h-10 inline-flex items-center justify-center rounded-xl px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
        >
          {trigger === "preflight-gate" ? "Skip for now" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

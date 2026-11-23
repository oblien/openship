import type { BuildStrategy } from "@repo/core";
import type { AmbientGitVia, CommandExecutor } from "@repo/adapters";
import type { ExecutionContext as RequestContext } from "../../../context";

export interface BuildGitCredential {
  token?: string;
  /** Ephemeral exact repository grant returned by the App credential resolver. */
  tokenRepositories?: string[];
  relay?: boolean;
  /**
   * The TARGET SERVER authenticates the clone with its own pre-existing git
   * credentials, verified against this repo by `probeServerGitAccess`. Nothing is
   * shipped to it and nothing is read off it. Valid only for a clone that runs on
   * that server.
   */
  ambient?: { via: AmbientGitVia };
  /**
   * Public repo on a remote clone: no credential is needed at all, so an
   * on-server clone (or anonymous tarball download) can proceed. Distinct from
   * `{}` — which also means "local build, nothing resolved" — because the
   * pipeline must be able to tell "nothing needed" from "nothing available".
   */
  anonymous?: boolean;
  /**
   * Set when a server clone-on-server was requested but no SHIPPABLE credential
   * (relay / App / PAT) exists, so the caller must degrade to an api-host clone
   * (clone on the orchestrator, transfer the context). Any `token` returned
   * alongside this is a LOCAL credential valid ONLY for cloning on this host — it
   * must NOT be shipped off-host. Callers therefore treat token-presence as
   * "shippable" only when this flag is absent.
   */
  apiHostFallback?: boolean;
  /**
   * SSH credential for cloning over git@github.com. Returned by a per-server
   * config whose mode is ssh-server-key / ssh-deploy-key. Can't be a `token`
   * (HTTPS-only), so it's carried here and consumed by the adapter clone step
   * (GIT_SSH_COMMAND with a 0600 key + pinned known_hosts). Decrypted only at
   * deploy time; never logged.
   */
  ssh?: {
    keyKind: "server-key" | "deploy-key";
    /** Decrypted OpenSSH private key. */
    privateKey: string;
    /** Pinned github.com host keys for StrictHostKeyChecking. */
    knownHosts: string;
  };
}

export interface GitCloneOptions {
  /** Caller's request context. Carries userId + organizationId; org-scoped
   *  App installation lookup uses ctx.organizationId. */
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  /** Repo name — threaded to the github-access gate for PER-REPO
   *  authorization (so a member granted only repo X can build X). */
  repo?: string | null;
  /** Server-resolved project snapshot; validated against org+owner before use. */
  installationId?: number | null;
  buildStrategy: BuildStrategy;
  /**
   * Target server id (server deploys). When set, a per-server GitHub auth
   * config wins for clones that run on THAT server (self-hosted only). Left
   * unset for local/cloud clones.
   */
  serverId?: string | null;
  /**
   * Desktop-only: when a SERVER build has no remote token (no App / PAT),
   * signal `{ relay: true }` instead of throwing — set by the orchestrator only
   * when the operator opted in for THIS deploy (the deploy flow's "Forward my
   * git credentials" choice → `snapshot.forwardGitCredentials`) and it's an
   * eligible (non-docker) server build. The gh token is NOT returned here; it's
   * fetched on demand by the relay's remote helper, so it never lands on the
   * build host.
   */
  allowRelayFallback?: boolean;
  /**
   * DOCKER clone-on-server only: when a SERVER clone has no shippable credential
   * (no relay, no App/PAT), degrade to an api-host clone instead of throwing —
   * return `{ apiHostFallback: true }` (with a LOCAL token when one exists). The
   * pipeline then clones on the orchestrator and transfers the context. Bare
   * server builds must NOT set this (they can only clone on the target and are
   * gated by their own hard-fail preflight checks).
   */
  allowApiHostFallback?: boolean;
  /**
   * Executor for the TARGET SERVER, when the clone will run there. Enables the
   * ambient probe ("can this server reach the repo with its own credentials?").
   * Omit for local/cloud clones — there is no server identity to consult.
   */
  serverExecutor?: Pick<CommandExecutor, "exec"> | null;
  /** Clone URL, required by the ambient probe (it verifies this exact remote). */
  repoUrl?: string | null;
  /** Build-log sink for the probe's one-line outcome. Never receives secrets. */
  onLog?: (message: string) => void;
  /** Commit sha or branch being deployed; `.gitmodules` is read at this ref. */
  gitRef?: string | null;
}

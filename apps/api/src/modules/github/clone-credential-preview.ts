/**
 * Which credential will actually clone — metadata only, never the secret.
 *
 * Browse uses the connected identity (device / PAT / gh / App). Clone on a
 * server prefers that server's stored cred (deploy key / SSH / device / PAT),
 * then desktop forwarding, then the instance identity. Operator edition has
 * no Cloud-forwarded GitHub App in this chain (capabilities already hide it).
 */

import { repos } from "@repo/db";
import { resolveEditionState } from "@repo/core";
import { env } from "../../config/env";
import type { RequestContext } from "../../lib/request-context";
import { getDeployDefaults } from "../settings/settings.service";
import type { GitHubConnectionState } from "./github.types";

export type CloneCredentialKind =
  | "deploy-key"
  | "ssh"
  | "device"
  | "pat"
  | "forwarding"
  | "gh-cli"
  | "app"
  | "none";

export interface CloneIdentity {
  login: string | null;
  method: "device" | "pat" | "gh-cli" | "app" | "none";
}

export interface CloneCredentialPreview {
  browseAs: CloneIdentity;
  clone: {
    kind: CloneCredentialKind;
    label: string;
    login: string | null;
    appliesTo: "local" | "server" | "both";
    serverId: string | null;
    serverName: string | null;
  };
}

const LABELS: Record<CloneCredentialKind, string> = {
  "deploy-key": "Per-repo deploy key on the server",
  ssh: "Server SSH key",
  device: "GitHub device sign-in",
  pat: "Personal access token",
  forwarding: "Desktop identity forwarded over SSH",
  "gh-cli": "gh CLI on this host",
  app: "Openship Cloud GitHub App",
  none: "No clone credential configured",
};

export function browseIdentityFromState(state: GitHubConnectionState): CloneIdentity {
  if (state.primary === "openship-app" && state.sources.openshipApp.connected) {
    return { login: state.sources.openshipApp.login ?? null, method: "app" };
  }
  if (state.sources.ghCli.available) {
    const method =
      state.sources.ghCli.method === "device"
        ? "device"
        : state.sources.ghCli.method === "token"
          ? "pat"
          : "gh-cli";
    return { login: state.sources.ghCli.login ?? null, method };
  }
  if (state.sources.openshipApp.connected) {
    return { login: state.sources.openshipApp.login ?? null, method: "app" };
  }
  return { login: null, method: "none" };
}

export async function describeCloneCredentials(
  ctx: RequestContext,
  state: GitHubConnectionState,
  opts?: { serverId?: string | null },
): Promise<CloneCredentialPreview> {
  const browseAs = browseIdentityFromState(state);
  const defaults = await getDeployDefaults(ctx.userId).catch(() => ({
    defaultServerId: null as string | null,
  }));
  const serverId = opts?.serverId || defaults.defaultServerId || null;
  const server = serverId
    ? await repos.server.getInOrganization(serverId, ctx.organizationId).catch(() => null)
    : null;
  const resolvedServerId = server?.id ?? serverId;
  const serverName = server?.name?.trim() || server?.sshHost?.trim() || resolvedServerId;

  const settings = await repos.settings.findByUser(ctx.userId).catch(() => null);
  const desktop = env.DEPLOY_MODE === "desktop";
  // Same operator precedence as clone-auth: desktop forwarding wins, then the
  // server's stored cred, then the instance identity. Ambient server git is
  // probed at deploy time and is not a stored credential we can name here.
  if (desktop && settings?.forwardGitToServer === true && browseAs.method !== "none") {
    return preview(browseAs, "forwarding", browseAs.login, "both", resolvedServerId, serverName);
  }

  if (resolvedServerId) {
    const row = await repos.serverGithubAuth.getByServer(resolvedServerId).catch(() => null);
    if (row?.mode === "ssh-deploy-key") {
      return preview(browseAs, "deploy-key", row.tokenLogin, "server", resolvedServerId, serverName);
    }
    if (row?.mode === "ssh-server-key") {
      return preview(browseAs, "ssh", null, "server", resolvedServerId, serverName);
    }
    if (row?.mode === "token") {
      const kind = row.tokenSource === "device-flow" ? "device" : "pat";
      return preview(browseAs, kind, row.tokenLogin, "server", resolvedServerId, serverName);
    }
  }

  if (browseAs.method === "device") {
    return preview(browseAs, "device", browseAs.login, "local", resolvedServerId, serverName);
  }
  if (browseAs.method === "pat") {
    return preview(browseAs, "pat", browseAs.login, "local", resolvedServerId, serverName);
  }
  if (browseAs.method === "gh-cli") {
    return preview(browseAs, "gh-cli", browseAs.login, "local", resolvedServerId, serverName);
  }

  const { features } = resolveEditionState({ cloudMode: env.CLOUD_MODE === true });
  if (features.hostedGithubApp && browseAs.method === "app") {
    return preview(browseAs, "app", browseAs.login, "both", resolvedServerId, serverName);
  }

  return preview(browseAs, "none", null, serverId ? "server" : "local", resolvedServerId, serverName);
}

function preview(
  browseAs: CloneIdentity,
  kind: CloneCredentialKind,
  login: string | null | undefined,
  appliesTo: CloneCredentialPreview["clone"]["appliesTo"],
  serverId: string | null,
  serverName: string | null | undefined,
): CloneCredentialPreview {
  return {
    browseAs,
    clone: {
      kind,
      label: LABELS[kind],
      login: login ?? null,
      appliesTo,
      serverId,
      serverName: serverName ?? null,
    },
  };
}

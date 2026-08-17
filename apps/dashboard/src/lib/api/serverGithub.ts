import { api } from "./client";
import { endpoints } from "./endpoints";

export type ServerGithubMode = "token" | "ssh-server-key" | "ssh-deploy-key";

export interface CloneAccessTest {
  ok: boolean;
  via: "ls-remote" | "server" | "api" | "pending" | "none";
  message: string;
  repo?: string;
}

export interface ServerGithubStatus {
  mode: ServerGithubMode | null;
  connected: boolean;
  tokenSource?: "device-flow" | "pat" | null;
  tokenLogin?: string | null;
  serverKeyPublic?: string | null;
  deployKeyCount: number;
  deployKeys?: Array<{ owner: string; repo: string; createdAt: string }>;
}

export interface ServerGithubDeviceFlow {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Per-server GitHub auth (self-hosted). Backs the server detail "GitHub" card. */
export const serverGithubApi = {
  get: (id: string) => api.get<ServerGithubStatus>(endpoints.system.serverGithub(id)),

  /** Start a device-flow login; poll `connectPoll` until complete. */
  connect: (id: string) =>
    api.post<ServerGithubDeviceFlow>(endpoints.system.serverGithubConnect(id)),

  connectPoll: (id: string) =>
    api.get<{ data: { status: "waiting" | "complete" | "error"; error?: string } | null }>(
      endpoints.system.serverGithubConnectPoll(id),
    ),

  setToken: (id: string, token: string) =>
    api.put<{ login: string; cloneTest?: CloneAccessTest }>(endpoints.system.serverGithubToken(id), { token }),

  /** Generate (or return) the server's SSH key; returns the public line to add
   *  to the operator's GitHub account. */
  generateSshKey: (id: string) =>
    api.post<{ publicKey: string }>(endpoints.system.serverGithubSshKey(id)),

  useDeployKeyMode: (id: string) =>
    api.put<{ ok: true }>(endpoints.system.serverGithubDeployKeyMode(id), {}),

  disconnect: (id: string) => api.delete<{ ok: true }>(endpoints.system.serverGithub(id)),
};

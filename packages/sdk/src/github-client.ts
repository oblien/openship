import { GitHubCollectionSchemas, GitHubResourceSchemas, type GitHubOperations, isRecord } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations, createRemoteResourceOperations } from "./resource-client";
const part = (input: unknown, key: string) => encodeURIComponent(String(isRecord(input) ? input[key] : ""));
const repo = (input: unknown) => `/github/repos/${part(input, "owner")}/${part(input, "repo")}`;
export function createRemoteGitHubOperations(http: HttpClient): GitHubOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, GitHubCollectionSchemas, {
      getStatus: { method: "GET", path: () => "/github/status" },
      getHome: { method: "GET", path: () => "/github/home" },
      getLocalStatus: { method: "GET", path: () => "/github/local-status" },
      pollConnect: { method: "GET", path: () => "/github/connect/poll", resultStatuses: [404] },
      connect: { method: "POST", path: () => "/github/connect" },
      claimInstallation: { method: "POST", path: () => "/github/installations/claim" },
      setInstanceToken: { method: "POST", path: () => "/github/instance-token" },
      disconnect: { method: "POST", path: () => "/github/disconnect" },
      listRepos: { method: "GET", path: () => "/github/repos" },
      listOrgRepos: { method: "GET", path: input => `/github/orgs/${part(input, "org")}/repos` },
      getRepo: { method: "GET", path: repo, envelope: "data" },
      createRepo: { method: "POST", path: () => "/github/repos", envelope: "data" },
      deleteRepo: { method: "DELETE", path: repo },
      listBranches: { method: "GET", path: input => `${repo(input)}/branches` },
      getCloneToken: { method: "GET", path: input => `${repo(input)}/clone-token` },
      detectStack: { method: "GET", path: input => `${repo(input)}/detect`, envelope: "data" },
      listFiles: { method: "GET", path: input => `${repo(input)}/files`, envelope: "data" },
      listTree: { method: "GET", path: input => `${repo(input)}/tree`, envelope: "data" },
      getFile: { method: "GET", path: input => `${repo(input)}/file`, envelope: "data" },
      listWebhooks: { method: "GET", path: input => `${repo(input)}/webhooks`, envelope: "data" },
      registerWebhook: { method: "POST", path: input => `${repo(input)}/webhooks`, envelope: "data" },
      deleteWebhook: { method: "DELETE", path: input => `${repo(input)}/webhooks` },
      listSources: { method: "GET", path: () => "/github/sources" },
      beginManifest: { method: "POST", path: () => "/github/sources/manifest" },
      convertManifest: { method: "POST", path: () => "/github/sources/manifest/convert" },
      createManualSource: { method: "POST", path: () => "/github/sources/manual" },
    }),
    ...createRemoteResourceOperations(http, GitHubResourceSchemas, {
      updateSource: { method: "PATCH", path: id => `/github/sources/${encodeURIComponent(id)}`, envelope: "data" },
      verifySource: { method: "POST", path: id => `/github/sources/${encodeURIComponent(id)}/verify`, envelope: "data" },
      setDefaultSource: { method: "POST", path: id => `/github/sources/${encodeURIComponent(id)}/default`, envelope: "data" },
      createInstallUrl: { method: "POST", path: id => `/github/sources/${encodeURIComponent(id)}/install` },
      deleteSource: { method: "DELETE", path: id => `/github/sources/${encodeURIComponent(id)}` },
    }),
  });
}

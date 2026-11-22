import { GitCollectionSchemas, type GitOperations, isRecord } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

const part = (input: unknown, key: string) =>
  encodeURIComponent(String(isRecord(input) ? input[key] : ""));
const repos = (input: unknown) => `/git/${part(input, "provider")}/repos`;
const repo = (input: unknown) => `${repos(input)}/${part(input, "owner")}/${part(input, "repo")}`;

export function createRemoteGitOperations(http: HttpClient): GitOperations {
  return createRemoteScopedOperations(http, GitCollectionSchemas, {
    listRepos: { method: "GET", path: repos },
    getRepo: { method: "GET", path: repo, envelope: "data" },
    listBranches: { method: "GET", path: (input) => `${repo(input)}/branches` },
    listFiles: { method: "GET", path: (input) => `${repo(input)}/files`, envelope: "data" },
    listTree: { method: "GET", path: (input) => `${repo(input)}/tree`, envelope: "data" },
    getFile: { method: "GET", path: (input) => `${repo(input)}/file`, envelope: "data" },
    detectStack: { method: "GET", path: (input) => `${repo(input)}/detect`, envelope: "data" },
    publishChange: { method: "POST", path: (input) => `${repo(input)}/changes`, envelope: "data" },
  });
}

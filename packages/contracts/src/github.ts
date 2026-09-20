import { Type, type Static } from "@sinclair/typebox";
import { OwnerRepoParams, CreateRepoBody, WebhookDeleteBody, GitHubSourceManifestBody, GitHubSourceManifestConvertBody, GitHubSourceManualBody, GitHubSourceUpdateBody } from "./github-inputs";
import { SourceScanSchema } from "./sources";
import type { ResourceOperationSchema, ScopedOperations, ResourceOperations } from "./resource-operations";
import type { MappedRepository, MappedAccount, RepositoryDetail, GitHubBranch, GitHubFileContent, GitHubWebhook, GitHubConnectionState, GitHubRepository } from "./github-types";
export * from "./github-inputs";
export * from "./github-types";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const optionalString = Type.Optional(Type.String());
const bool = Type.Boolean();
const strings = Type.Array(Type.String());
const success = Type.Object({ success: Type.Literal(true) });
export const GitHubRepoListInput = Type.Object({
  owner: Type.Optional(OwnerRepoParams.properties.owner),
  page: Type.Optional(Type.Number({ minimum: 0 })), perPage: Type.Optional(Type.Number({ minimum: 0 })),
  search: Type.Optional(Type.String({ maxLength: 500 })),
  visibility: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("public"), Type.Literal("private")])),
  sort: Type.Optional(Type.Union([Type.Literal("updated"), Type.Literal("name"), Type.Literal("stars")])),
});
const branch = Type.Optional(Type.String({ minLength: 1, maxLength: 200 }));
const RepoBranchInput = Type.Object({ ...OwnerRepoParams.properties, branch });
const FileInput = Type.Object({ ...OwnerRepoParams.properties, branch, path: Type.Optional(Type.String({ maxLength: 4096 })) });
export const GitHubBranchSchema = Type.Unsafe<GitHubBranch>(Type.Object({ name: Type.String(), commit: Type.Object({ sha: Type.String(), url: Type.String() }), protected: bool }));
export const BranchPageInput = Type.Object({ page: Type.Optional(Type.Integer({ minimum: 1 })) });
export const BranchPaginationSchema = Type.Object({
  page: Type.Integer({ minimum: 1 }),
  perPage: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
});
export const GitHubRepositorySchema = Type.Unsafe<MappedRepository>(Type.Object({
  full_name: Type.String(), name: Type.String(), owner: Type.String(), description: nullableString,
  html_url: Type.String(), private: bool, visibility: Type.String(), default_branch: Type.String(),
  language: nullableString, size: Type.Number(), forks: Type.Number(), watchers: Type.Number(), stars: Type.Number(),
  license: Type.Unknown(), created_at: Type.String(), updated_at: Type.String(), pushed_at: Type.String(),
  source: Type.Optional(Type.Union([Type.Literal("app"), Type.Literal("cli"), Type.Literal("both")])),
}));
export const GitHubAccountSchema = Type.Unsafe<MappedAccount>(Type.Object({
  login: Type.String(), id: Type.Number(), avatar_url: Type.String(), type: Type.String(), source: optionalString,
}));
export const GitHubStateSchema = Type.Unsafe<GitHubConnectionState>(Type.Object({
  sources: Type.Object({
    openshipApp: Type.Object({ connected: bool, login: optionalString, avatarUrl: optionalString, hasInstallations: Type.Optional(bool) }),
    ghCli: Type.Object({ available: bool, login: optionalString, avatarUrl: optionalString, method: optionalString, problem: optionalString, checkedAt: optionalString }),
  }),
  primary: Type.Union([Type.Literal("openship-app"), Type.Literal("gh-cli"), Type.Null()]),
}));
const methodKind = Type.Union([Type.Literal("device"), Type.Literal("token"), Type.Literal("app"), Type.Literal("ssh-key"), Type.Literal("forwarding")]);
export const GitHubCapabilitiesSchema = Type.Object({
  platform: Type.Union([Type.Literal("saas"), Type.Literal("selfhosted")]), desktop: bool,
  primary: Type.Union([methodKind, Type.Null()]),
  methods: Type.Array(Type.Object({ kind: methodKind, available: bool, configured: bool, requiresCloud: Type.Optional(bool), unavailableReason: optionalString })),
});
const connection = {
  state: GitHubStateSchema, accounts: Type.Array(GitHubAccountSchema), installUrl: Type.String(), cloudUnreachable: bool,
  capabilities: Type.Union([GitHubCapabilitiesSchema, Type.Null()]),
};
const RepoDetail = Type.Unsafe<RepositoryDetail>(Type.Object({
  id: Type.Number(), name: Type.String(), full_name: Type.String(), owner: Type.String(), private: bool,
  default_branch: Type.String(), clone_url: Type.String(), ssh_url: Type.String(), html_url: Type.String(), branches: Type.Optional(Type.Array(GitHubBranchSchema)), branches_has_more: Type.Optional(bool),
}));
const CreatedRepository = Type.Unsafe<GitHubRepository>(Type.Object({
  id: Type.Number(), name: Type.String(), full_name: Type.String(), owner: Type.Object({ login: Type.String(), id: Type.Number(), avatar_url: Type.String() }),
  private: bool, default_branch: Type.String(), clone_url: Type.String(), html_url: Type.String(),
}));
const FileEntry = Type.Unsafe<GitHubFileContent>(Type.Object({
  name: Type.String(), path: Type.String(), sha: Type.String(), size: Type.Number(), type: Type.Union([Type.Literal("file"), Type.Literal("dir")]),
  content: optionalString, encoding: optionalString, download_url: nullableString,
}));
const Webhook = Type.Unsafe<GitHubWebhook>(Type.Object({
  id: Type.Number(), active: bool, events: strings, config: Type.Object({ url: Type.String(), content_type: Type.String() }),
}));
export const GitHubSourceSchema = Type.Object({
  id: Type.String(), name: Type.String(), provider: Type.Literal("github"), appId: Type.Number(), slug: Type.String(),
  clientId: nullableString, appName: nullableString, avatarUrl: nullableString, apiBaseUrl: Type.String(), webBaseUrl: Type.String(),
  webhookUrl: Type.String(), setupUrl: Type.String(), appUrl: Type.String(), managementUrl: Type.String(),
  isDefault: bool, status: Type.String(), lastVerifiedAt: nullableString, lastError: nullableString,
  installations: Type.Array(Type.Object({ id: Type.Number(), owner: Type.String(), ownerType: Type.String(), avatarUrl: Type.String(), suspendedAt: nullableString })),
  createdAt: Type.String(), updatedAt: Type.String(),
});
const sourceCreated = Type.Object({ data: GitHubSourceSchema, installUrl: Type.String() });
const repoList = Type.Object({ data: Type.Array(GitHubRepositorySchema), page: Type.Number(), perPage: Type.Number(), count: Type.Number(), total: Type.Number(), publicCount: Type.Number(), privateCount: Type.Number(), totalPages: Type.Number() });
export const GitHubConnectInput = Type.Object({ source: Type.Optional(Type.Union([Type.Literal("oauth"), Type.Literal("cli")])) });
export const GitHubDisconnectInput = Type.Object({ source: Type.Optional(Type.Union([Type.Literal("oauth"), Type.Literal("cli"), Type.Literal("all")])) });
export const GitHubTokenInput = Type.Object({ token: Type.String({ minLength: 1, maxLength: 4096 }) });
export const GitHubPollSchema = Type.Object({ status: Type.Union([Type.Literal("none"), Type.Literal("waiting"), Type.Literal("complete"), Type.Literal("error")]), error: optionalString });
export const GitHubCollectionSchemas = {
  getStatus: { action: "read", output: Type.Object({ ...connection, customSourcesConfigured: bool }) },
  getHome: { action: "read", output: Type.Object({ ...connection, repos: Type.Array(GitHubRepositorySchema), errors: Type.Optional(Type.Record(Type.String(), Type.String())) }) },
  connect: { action: "write", input: GitHubConnectInput, optionalInput: true, output: Type.Union([
    Type.Object({ connected: Type.Literal(true) }),
    Type.Object({ connected: Type.Literal(false), flow: Type.Literal("redirect"), url: optionalString, state: optionalString, step: optionalString }),
    Type.Object({ connected: Type.Literal(false), flow: Type.Literal("device_code"), userCode: Type.String(), verificationUri: Type.String(), expiresIn: Type.Number(), interval: Type.Number() }),
    Type.Object({ connected: Type.Literal(false), flow: Type.Union([Type.Literal("token"), Type.Literal("terminal")]), command: Type.String(), message: Type.String() }),
  ]) },
  claimInstallation: { action: "write", input: Type.Object({ state: Type.String({ minLength: 1, maxLength: 256 }), installationId: Type.Union([Type.String({ minLength: 1, maxLength: 30 }), Type.Integer({ minimum: 1 })]), setupAction: optionalString }), output: Type.Object({ ok: Type.Literal(true), pendingApproval: Type.Optional(bool), installation: Type.Optional(Type.Object({ id: Type.Number(), login: Type.String(), type: Type.String() })) }) },
  getLocalStatus: { action: "read", output: Type.Object({ available: bool, activeMode: Type.String(), method: Type.Optional(nullableString), login: optionalString, id: Type.Optional(Type.Number()), avatar_url: optionalString, problem: optionalString, checkedAt: optionalString }) },
  pollConnect: { action: "read", output: GitHubPollSchema },
  setInstanceToken: { action: "write", input: GitHubTokenInput, output: Type.Object({ connected: Type.Literal(true), login: Type.String(), warning: optionalString }) },
  disconnect: { action: "write", input: GitHubDisconnectInput, optionalInput: true, output: Type.Object({ success: Type.Literal(true), source: Type.Union([Type.Literal("oauth"), Type.Literal("cli"), Type.Literal("all")]) }) },
  listRepos: { action: "read", input: GitHubRepoListInput, optionalInput: true, output: repoList },
  listOrgRepos: { action: "read", input: Type.Object({ ...GitHubRepoListInput.properties, org: OwnerRepoParams.properties.owner }), output: repoList },
  getRepo: { action: "read", input: Type.Object({ ...OwnerRepoParams.properties, branches: Type.Optional(bool) }), output: RepoDetail },
  createRepo: { action: "write", input: CreateRepoBody, output: CreatedRepository },
  deleteRepo: { action: "admin", input: OwnerRepoParams, output: success },
  listBranches: {
    action: "read",
    input: Type.Object({ ...OwnerRepoParams.properties, ...BranchPageInput.properties }),
    output: Type.Object({ data: Type.Array(GitHubBranchSchema), pagination: BranchPaginationSchema }),
  },
  getCloneToken: { action: "read", input: OwnerRepoParams, output: Type.Object({ token: Type.String(), cloneUrl: Type.String(), command: Type.String() }) },
  detectStack: { action: "read", input: Type.Object({ ...RepoBranchInput.properties, composePath: Type.Optional(Type.String({ maxLength: 4096 })) }), output: SourceScanSchema },
  listFiles: { action: "read", input: FileInput, output: Type.Union([Type.Array(FileEntry), FileEntry]) },
  listTree: { action: "read", input: RepoBranchInput, output: Type.Array(Type.Object({ path: Type.String(), type: Type.Union([Type.Literal("file"), Type.Literal("dir")]) })) },
  getFile: { action: "read", input: Type.Object({ ...RepoBranchInput.properties, file: Type.String({ minLength: 1, maxLength: 4096 }) }), output: Type.Object({ sha: Type.String(), size: Type.Number(), content: Type.String(), download_url: nullableString }) },
  listWebhooks: { action: "read", input: OwnerRepoParams, output: Type.Array(Webhook) },
  registerWebhook: { action: "write", input: OwnerRepoParams, output: Webhook },
  deleteWebhook: { action: "admin", input: Type.Object({ ...OwnerRepoParams.properties, ...WebhookDeleteBody.properties }), output: success },
  listSources: { action: "read", output: Type.Object({ data: Type.Array(GitHubSourceSchema), configuration: Type.Object({ publicReady: bool, publicUrl: nullableString, webhookUrl: Type.String(), setupUrl: Type.String() }) }) },
  beginManifest: { action: "write", input: GitHubSourceManifestBody, output: Type.Object({ url: Type.String(), manifest: Type.Record(Type.String(), Type.Unknown()) }) },
  convertManifest: { action: "write", input: GitHubSourceManifestConvertBody, output: sourceCreated },
  createManualSource: { action: "write", input: GitHubSourceManualBody, output: sourceCreated },
} as const satisfies Record<string, ResourceOperationSchema>;
export const GitHubResourceSchemas = {
  updateSource: { action: "write", input: GitHubSourceUpdateBody, output: GitHubSourceSchema },
  verifySource: { action: "write", output: GitHubSourceSchema },
  setDefaultSource: { action: "write", output: GitHubSourceSchema },
  createInstallUrl: { action: "write", output: Type.Object({ url: Type.String(), state: Type.String() }) },
  deleteSource: { action: "write", output: success },
} as const satisfies Record<string, ResourceOperationSchema>;
export type PublicGitHubSource = Static<typeof GitHubSourceSchema>;
export interface GitHubOperations extends ScopedOperations<typeof GitHubCollectionSchemas>, ResourceOperations<typeof GitHubResourceSchemas> {}

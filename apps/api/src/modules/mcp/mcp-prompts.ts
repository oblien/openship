import { getMcpTools } from "./mcp-tools";
import { env, cloudRuntimeTarget } from "@repo/platform/engine/config/index";

/**
 * MCP `prompts` — the guided-flow catalog. Tools tell an agent WHAT it can do
 * one call at a time; prompts explain HOW the multi-step flows chain together
 * (which tool feeds which, where the out-of-band steps are). MCP clients surface
 * these as slash-commands / starters, so they double as the discoverable entry
 * points a flat `tools/list` can't provide.
 *
 * Each prompt's text references tools by their REAL generated names, resolved at
 * build time from the live registry (see `toolRef`) — so if a route's path or
 * method changes, the prompt points at the right tool or falls back visibly to
 * "METHOD /path" instead of drifting to a stale name.
 */

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments?: McpPromptArgument[];
  localOnly?: boolean;
  /** Build the guidance body. `ref(method, path)` → the tool's generated name. */
  build: (args: Record<string, string>, ref: (method: string, path: string) => string) => string;
}

/** Resolve a route (method + full path) to its generated MCP tool name. */
function toolRef(method: string, path: string): string {
  const t = getMcpTools().find((x) => x.method === method && x.path.replace(/\/+$/, "") === path.replace(/\/+$/, ""));
  return t ? t.name : `${method} ${path}`;
}

/** Shared by initialize and every guided flow, before any creation steps. */
export function workspaceInstructions(workspace?: { organizationId: string | null; boundOrganizationId: string | null }): string {
  return [
    "Openship workspaces and workgroups are organizations in the API. Their workspace ID is organizationId. An Oblien runtime workspace and a project's groupId are different resources.",
    ...(workspace?.organizationId ? [`Current organizationId: ${workspace.organizationId}.`] : []),
    ...(workspace?.boundOrganizationId ? [`This credential is bound to organizationId ${workspace.boundOrganizationId}.`] : []),
    `Before installing an app, creating a project, or deploying Compose, call ${toolRef("GET", "/api/permissions/workspaces")} with no arguments. It lists permitted workspace names and organizationId values, including empty workspaces, and reports the current workspace and credential restrictions.`,
    "Match the user's requested workspace to that list. If several workspaces are available and the destination is unspecified or ambiguous, ask which one to use before creating resources. Never substitute the default when the requested workspace is unavailable.",
    "Pass the chosen organizationId as a TOP-LEVEL argument alongside body/query on every tool call in the flow (scan, create/ensure, install, service changes, deploy and status). It is fixed scope for that call; no active-workspace switch is persisted. For an authenticated out-of-band upload, also send X-Organization-Id and X-Openship-Scope: fixed.",
    "If boundOrganizationId is set, this credential only accesses that workspace. To use another, the user must authorize a connection or create a token in that workspace; passing a different ID cannot widen access.",
    "organizationId selects the request's workspace; serverId selects where the app runs. Neither moves existing project records between Openship instances.",
    ...(env.CLOUD_MODE ? [
      "This is Openship Cloud. Local filesystem paths are not accessible here; use uploaded source or a git repository. Managed servers build on the server (buildStrategy:'server').",
    ] : [
      `To run a desktop/self-hosted project on Cloud, call ${toolRef("GET", "/api/system/servers/destinations")} and select an accessible managed server. Pass its local serverId when creating/importing the project, then deploy that project with buildStrategy:'server'. The project and source stay controlled by this instance; no transfer_to_cloud is needed. The credential must have project creation/write and destination server write permissions.`,
      `If the server is not connected here, an authorized administrator can select it from ${toolRef("GET", "/api/system/servers/managed/available")} and use ${toolRef("POST", "/api/system/servers/managed/connect")}. Use the returned LOCAL serverId, not the remote Cloud ID.`,
      `A Cloud account link does not grant this credential access to projects stored in Cloud. For those projects, authorize a separate MCP connection to ${cloudRuntimeTarget.api}/api/mcp and select its Cloud organizationId. CLOUD_SCOPE_UNAVAILABLE cannot be bypassed by omitting organizationId or by sending the Cloud ID to this local connection.`,
    ]),
  ].join("\n");
}

/**
 * Appended to every prompt: if the agent hits something that looks like an
 * Openship platform bug (not a user-input error), it should point the user at
 * the issue tracker rather than silently working around it.
 */
const BUG_REPORT =
  "If an Openship tool fails unexpectedly, report the tool name, error code and a redacted reproduction at https://github.com/oblien/openship/issues. Remove tokens, passwords, environment values and other secrets from arguments and logs before sharing them.";

const PROMPTS: PromptDef[] = [
  {
    name: "openship-overview",
    title: "Openship: how to drive it via MCP",
    description:
      "Orientation: the main tool groups, the entry points for each flow, and how permission scoping (incl. per-repo GitHub grants) affects what you can see and do.",
    build: (_args, ref) =>
      [
        "You are driving Openship (deploy/host platform) through its MCP tools. Everything you call re-runs the real API's auth + permission checks, so you can only do what this token allows — `tools/list` already hides what you can't use.",
        "",
        "Main tool groups:",
        `- Projects — ${ref("GET", "/api/projects")} (list), ${ref("GET", "/api/projects/:id")} (detail), config/env/resources/branch setters.`,
        `- Deployments — ${ref("POST", "/api/deployments/build/access")} (deploy), ${ref("GET", "/api/deployments/:id")} (status), ${ref("GET", "/api/deployments/:id/logs")} (logs), rollback/redeploy/restart.`,
        `- GitHub — ${ref("GET", "/api/github/home")} (accounts + repos in one call), browse repos/branches, and ${ref("GET", "/api/github/repos/:owner/:repo/detect")} for build config (read-only; you cannot create/delete repos via MCP).`,
        `- Catalog apps — ${ref("GET", "/api/apps/catalog")} (list), ${ref("POST", "/api/apps")} (install).`,
        "- Domains, jobs, webhooks, notifications, analytics, backups — inspect current state, configure, run and recover.",
        "- Self-hosted infrastructure — private networks, server clusters, application scaling, shared files and managed databases. These tools do not implement policy-driven autoscaling or live worker joining.",
        "",
        "Guided flows (fetch these prompts for step-by-step chains):",
        "- `deploy-from-git` — deploy a GitHub/linked repo.",
        "- `deploy-a-folder` — deploy a controller-local source folder, or upload from another machine using an authenticated HTTP client.",
        "- `install-catalog-app` — install a one-click app.",
        "- `cluster-and-scale` — private networking → server cluster → optional shared files → application deployment → scale → recovery/cleanup (self-hosted).",
        "- `cluster-database` — provision, connect, back up and recover a managed database (self-hosted).",
        "- `backup-and-restore` — destination → policy → backup → prepared restore → apply.",
        "- `migrate-docker-project` — inspect → preview → migrate → verify → explicit cutover (self-hosted).",
        "",
        "Permission scoping to know about:",
        "- A read-only token sees only GET tools. A restricted (scoped) token sees only tools for the resources it was granted.",
        "- GitHub access is default-DENY except the org owner: another member sees GitHub tools only if the owner granted them `github` (all), `github_installation` (one account), or `github_repository` (one repo). A repo-scoped token can browse and deploy exactly that repo.",
        "- Repo access is DEPLOY-ONLY by default: a repo grant lets you list it, read metadata/branches, and detect its build config — but NOT read file contents. Reading files needs content access, which the owner grants per repo and may restrict to specific paths. If the file tools aren't listed, you weren't granted content access; use `/detect` instead of asking for files, and only ask the user to widen the grant if you genuinely need to read source.",
        "",
        "Rule of thumb: read state first (list/get), make the change, then confirm by reading the new state.",
      ].join("\n"),
  },
  {
    name: "deploy-from-git",
    title: "Deploy a project from a git repository",
    description:
      "End-to-end: connect/verify GitHub, pick a repo, detect its stack, create the project, deploy, and watch the result.",
    arguments: [
      { name: "repo", description: "Target repo as owner/name (optional — you can browse first).", required: false },
      { name: "branch", description: "Branch to deploy (optional; defaults to the repo default).", required: false },
    ],
    build: (args, ref) => {
      const repo = args.repo ? ` Target repo: ${args.repo}.` : "";
      const branch = args.branch ? ` Deploy branch: ${args.branch}.` : "";
      return [
        `Deploy a git-hosted project.${repo}${branch}`,
        "",
        `1. Confirm GitHub is connected and find the repo: call ${ref("GET", "/api/github/home")} (returns connection state, accounts, and repos). If you need branches, ${ref("GET", "/api/github/repos/:owner/:repo/branches")}. To learn the build config, use ${ref("GET", "/api/github/repos/:owner/:repo/detect")} — it works on a deploy-only grant and returns the detected framework/commands directly, so you do NOT need to read files to configure a deploy.`,
        `2. Detect the stack/build config before committing: ${ref("POST", "/api/deployments/prepare")} with the repo/branch. Use what it returns (framework, install/build/start commands, port) in the next step.`,
        `3. Create the project from the git source: ${ref("POST", "/api/projects")}. Bake in the detected build config. (If the project already exists, skip to step 4; you can link a repo to an existing project with ${ref("POST", "/api/projects/:id/git/link")}.)`,
        `4. Deploy: ${ref("POST", "/api/deployments/build/access")} with the projectId from step 3. The project's selected serverId determines the destination; deployTarget alone does not select a managed server. Managed servers use buildStrategy:'server'. Optional wizard settings: envVars, publicEndpoints (omit to auto-derive a free subdomain), runtimeMode, cloudResourceTier. To redeploy an already-linked project later, ${ref("POST", "/api/deployments")} is the shortcut.`,
        `5. Watch it: poll ${ref("GET", "/api/deployments/:id")} for status/urls and ${ref("GET", "/api/deployments/:id/logs")} for build/runtime logs.`,
        `6. A deploy can STOP AND ASK — it is not always running or finished. If it seems stuck, or ends up \`action_required\`, call ${ref("GET", "/api/deployments/:id/pending")}. A held deploy is waiting on a decision (e.g. the port is already in use) and will ABORT on its own at the item's \`expiresAt\`; answer it with ${ref("POST", "/api/deployments/:id/build/respond")} using an action id from that item's \`resolveWith\` — never an id you guessed. Other items there resolve the same way, each carrying the exact call to make. ${ref("GET", "/api/projects/:id/pending-actions")} is the whole-project version (also covers domains, certificates and routing) — worth a look before reporting a deploy as simply failed.`,
      ].join("\n");
    },
  },
  {
    name: "deploy-a-folder",
    title: "Deploy a local source folder",
    description:
      "Use a controller-local path on desktop, or the authenticated upload flow for a folder on another machine. Source location and build location are separate choices.",
    build: (_args, ref) =>
      [
        ...(env.CLOUD_MODE ? [] : [
          "DESKTOP / SAME MACHINE — when the folder is readable by this Openship controller, no byte upload or bearer-token extraction is needed:",
          `1. Choose an accessible destination with ${ref("GET", "/api/system/servers/destinations")} if deploying to a server or Cloud.`,
          `2. For a new project, call ${ref("POST", "/api/projects/import")} with name, localPath and the selected serverId. It detects the source and returns the created project. For an existing local project, use its projectId instead of creating a duplicate.`,
          `3. Call ${ref("POST", "/api/deployments/build/access")} with that projectId and buildStrategy:'server' for a managed server. Openship reads the local source and transfers it to the selected server for the build. 'local' describes the source, not the build strategy. Do not transfer the project to Cloud.`,
          `4. Poll ${ref("GET", "/api/deployments/:id")} and ${ref("GET", "/api/deployments/:id/logs")}.`,
          "",
        ]),
        "UPLOAD — for a folder on a different machine, raw binary cannot cross JSON-RPC. Use an authenticated HTTP uploader (SDK, CLI or browser). OAuth bearer tokens stay in the MCP client; do not ask the assistant to extract them. If no authenticated uploader is available, use the desktop connection on the folder's machine or a git source.",
        "",
        `Before opening a session, choose or create a project with ${ref("POST", "/api/projects")} (name, gitProvider:'upload', serverId). A credential limited to its own projects must create the project first, then pass that projectId through session and ensure; an unbound session requires wildcard project write access.`,
        `1. Open an upload session: ${ref("POST", "/api/projects/folder/session")} with projectId. It returns \`upload\` = { url, absoluteUrl, method, headers, requiresAuth } and a sessionId.`,
        "1b. OUT OF BAND — gzip your folder into a tarball and POST the bytes to `upload.absoluteUrl` (the ready-to-use URL; `upload.url` is the same target relative to your API base) with the returned headers and Content-Type: application/gzip, plus your `Authorization: Bearer <token>` when `upload.requiresAuth` is true. Use a plain HTTP client; there is no MCP tool for this.",
        `2. Detect the uploaded source's stack: ${ref("POST", "/api/projects/folder/scan/:sessionId")} (body may be {}). Returns framework, package manager, install/build/start commands, output dir, port — plus a \`services\` array for a docker-compose folder.`,
        `3. Update that project's build config: ${ref("POST", "/api/projects/ensure")} with its explicit projectId and name. Map the scan fields in (framework = the scan's stack id) and set gitProvider:'upload'. If the scan returned \`services\`, pass that array through verbatim AND include \`uploadSessionId\` — env values come back masked ("••••••••"), and the session is what restores the real ones.`,
        `4. Deploy: ${ref("POST", "/api/deployments/build/access")} with projectId and uploadSessionId (step 1); use buildStrategy:'server' for a managed server. Then watch with ${ref("GET", "/api/deployments/:id")} and ${ref("GET", "/api/deployments/:id/logs")}.`,
      ].join("\n"),
  },
  {
    name: "install-catalog-app",
    title: "Install a one-click catalog app",
    description:
      "Install an app (Convex, WordPress, mail, …) from the catalog. Note some 'flow' apps (e.g. mail) return a flowHref to finish in the UI rather than installing in-band.",
    arguments: [
      { name: "app", description: "Catalog app id or name to install (optional — list first).", required: false },
    ],
    build: (args, ref) => {
      const app = args.app ? ` Target app: ${args.app}.` : "";
      return [
        `Install an app from the Openship catalog.${app}`,
        "",
        `1. Browse the catalog: ${ref("GET", "/api/apps/catalog")}. For one app's full template (services, config, endpoints): ${ref("GET", "/api/apps/catalog/:id")}.`,
        `2. Install it: ${ref("POST", "/api/apps")} with the app id and any required settings from the template.`,
        "3. Read the response: a normal app installs as a project (you'll get a project id — watch it like any deployment). A 'flow' / wizard app instead returns { kind: 'flow', flowHref } — that multi-step wizard (e.g. mail provisioning) is finished in the Openship UI at flowHref, not through MCP.",
        `4. For an installed app, its resolved connection details and curated settings are available via the project's app-settings/connection tools once it's running.`,
      ].join("\n");
    },
  },
  {
    name: "cluster-and-scale",
    title: "Run an application across servers",
    description: "Private networking, automated server setup, shared files, application deployment, guarded replica changes and recovery. Self-hosted only.",
    localOnly: true,
    build: (_args, ref) => [
      "This workflow runs on the Openship controller and its registered servers, not the MCP client. Use tools/list inputSchema for exact fields. Manual replicas (1–100) are supported; metric-driven autoscaling, adding/draining live workers and Compose application scaling are not implemented.",
      `1. Discover infrastructure with ${ref("GET", "/api/system/networks/capabilities")}, ${ref("GET", "/api/system/servers")}, ${ref("GET", "/api/system/networks")} and ${ref("GET", "/api/system/compute-clusters")}. Reuse suitable resources. Network and runtime mutations require fleet administration and access to every selected server.`,
      `2. For existing native private networking, inspect each host with ${ref("POST", "/api/system/servers/:id/network/inspect")}, register its actual addresses with ${ref("POST", "/api/system/networks")}, then ${ref("POST", "/api/system/networks/:id/verify")} using the saved revision. Poll ${ref("GET", "/api/system/networks/:id")} and inspect the dated peer report. Registration does not create provider networks or open provider firewalls.`,
      `3. Alternatively, start managed WireGuard preparation with ${ref("POST", "/api/system/networks/preparations")}. Persist requestId and reuse it after a lost response. Poll ${ref("GET", "/api/system/networks/preparations/:preparationId")}; follow operationId to ${ref("GET", "/api/system/networks/operations/:operationId")}. Review host changes and firewall requirements, then apply the exact planHash with ${ref("POST", "/api/system/networks/operations/:operationId/apply")}. Poll the same operation to completion. Full bidirectional member access is required for k3s. Failed operations offer explicit resume/rollback; do not create competing plans.`,
      `4. Create the compute cluster with ${ref("POST", "/api/system/compute-clusters")} using that networkId and its serverIds. Start ${ref("POST", "/api/system/compute-clusters/:id/runtime")} with the cluster’s revision and a stable requestId. Poll ${ref("GET", "/api/system/compute-clusters/:id/runtime")}; accepted is not ready. On failed/interrupted work, inspect per-host errors, fix prerequisites and use ${ref("POST", "/api/system/compute-clusters/:id/runtime/retry")} with the latest sequence. Never change membership while the runtime exists.`,
      `Optional shared files: use ${ref("POST", "/api/system/compute-clusters/:id/storage")} with at least two independent servers, reviewed empty directories and a stable requestId. Follow ${ref("GET", "/api/system/compute-clusters/:id/storage")} until ready. Failed/interrupted operations require an explicit retry with the current sequence. Set an external backup destination for recoverable archives. Once the project selects this cluster, create its shared volume with ${ref("POST", "/api/projects/:id/cluster/volumes")}, add it to config.mounts and deploy. Observe copies and attachment health with ${ref("GET", "/api/projects/:id/cluster/volumes")}. Host bind mounts and Compose conversion remain separate migration work.`,
      `5. Create or select a stateless single application. Read ${ref("GET", "/api/projects/:id/cluster")}, then ${ref("PATCH", "/api/projects/:id/cluster")} with clusterId, stateless:true, expectedUpdatedAt and config.replicas. Built images need config.imageRepository in a registry reachable by every node; configure registry credentials before deploying. This selects the next deployment target, it does not migrate persistent data.`,
      `6. Start ${ref("POST", "/api/deployments/build/access")} with projectId. Poll ${ref("GET", "/api/deployments/:id")} and ${ref("GET", "/api/deployments/:id/logs")}; inspect ${ref("GET", "/api/deployments/:id/pending")} for decisions. Read ${ref("GET", "/api/projects/:id/cluster")} for observed ready/available pods and ${ref("GET", "/api/projects/:id/pending-actions")} for routing/TLS blockers. Desired replicas alone do not prove health.`,
      `7. For each scale up or down, read cluster state again and call ${ref("POST", "/api/projects/:id/cluster/scale")} with replicas, expectedDeploymentId=activeDeploymentId and expectedUpdatedAt=updatedAt. Poll the returned deploymentId, then confirm ready/available replicas and public routing. Scaling reuses the retained image. On 409, re-read active state; do not replay stale guards or silently change intent.`,
      `8. Recover through deployment logs, pending actions and the retained-image rollback tool ${ref("POST", "/api/deployments/:id/rollback")}. Do not reset/reinstall infrastructure merely because an observation failed. Cleanup is explicit: disconnect and remove dependent applications, databases and shared volumes, then remove empty shared storage with ${ref("DELETE", "/api/system/compute-clusters/:id/storage")}. Remove the runtime with ${ref("DELETE", "/api/system/compute-clusters/:id/runtime")} using its current sequence and poll until removed; delete the empty compute cluster with its current revision. External archives are preserved. Remove managed networking through a reviewed removal plan, or the unused native network record with its revision. Never bypass dependency guards.`,
    ].join("\n\n"),
  },
  {
    name: "cluster-database",
    title: "Provision and recover a managed cluster database",
    description: "Add and scale PostgreSQL or Redis, back up and recover data, import existing project backups and review upgraded copies before changing application connections.",
    localOnly: true,
    build: (_args, ref) => [
      `1. Read ${ref("GET", "/api/projects/:id/cluster")} and ${ref("GET", "/api/projects/:id/cluster/databases")}. A ready cluster is required. Database replication is separate from scaling the application.`,
      `2. Create with ${ref("POST", "/api/projects/:id/cluster/databases")} and a stable requestId. Use only the engine/topology options advertised by inputSchema. Redis cluster mode requires clusterAwareClient:true; applications must support that protocol. Poll ${ref("POST", "/api/projects/:id/cluster/databases/inspect")} with databaseId and observe:true for native readiness, volumes and errors.`,
      `3. Save a supported database connection through ${ref("POST", "/api/projects/:id/cluster/databases/connect")}. Replacing an existing managed connection requires explicit review and replace.databaseId plus replace.expectedSequence for the source; the destination uses its own expectedSequence. Read the returned connection/environment state, then redeploy the app separately to apply it. Never replace a saved environment value with its masked display value.`,
      `4. Change permitted resources, PostgreSQL replicas, Redis shards or backup configuration with ${ref("PATCH", "/api/projects/:id/cluster/databases")} using expectedSequence from fresh inspection. Redis shard changes require confirmRedisRebalance:true after review and a verified recent backup. Failed/interrupted operations use ${ref("POST", "/api/projects/:id/cluster/databases/retry")}; re-read before retrying stale sequences. Engine changes and volume shrink are not supported; PostgreSQL major upgrades use a new copy.`,
      `5. Configure an eligible S3 destination and trigger ${ref("POST", "/api/projects/:id/cluster/databases/backup")} for PostgreSQL or Redis. Poll inspection until the native backup completes. Recover into a NEW database using restoreFrom and a backup name from inspection; verify data before switching connections. Redis captures consistent snapshots per shard, not a transaction across the cluster. The source database is retained.`,
      `Import or upgrade: ${ref("GET", "/api/projects/:id/cluster/databases/imports")} lists eligible existing Docker database backups. Create with importFrom.runId and importFrom.artifactName plus a ready clusterId while the app is still on Docker. For a PostgreSQL 17-to-18 upgrade, create with copyFrom.databaseId and its current expectedSequence, preserving the original. After verifying the target, choose that cluster for the application, explicitly save or replace its database connection and deploy. Pause source writes and take a fresh recovery point before a final cutover; later writes are not copied automatically.`,
      `6. Deletion uses ${ref("DELETE", "/api/projects/:id/cluster/databases")} with current expectedSequence and the database’s exact name. Review active connections and the deleteData choice first. Poll until cleanup finishes; keeping data can retain dependencies that block runtime removal.`,
    ].join("\n\n"),
  },
  {
    name: "backup-and-restore",
    title: "Back up application data and restore it",
    description: "Configure and test a destination, create/run a policy, follow every run, then prepare and explicitly apply a restore.",
    build: (_args, ref) => [
      `1. Read ${ref("GET", "/api/backup-destinations")} and ${ref("GET", "/api/projects/:projectId/backup-policies")}. Reuse a suitable destination/policy. New destinations use ${ref("POST", "/api/backup-destinations")} and ${ref("POST", "/api/backup-destinations/:id/preflight")}. Resolve failed connectivity/permission checks before starting backups.`,
      `2. Create or update the project/service policy with ${ref("POST", "/api/projects/:projectId/backup-policies")} or ${ref("PATCH", "/api/backup-policies/:policyId")}. Inspect payload, selected volumes, database dump support, schedule and retention. Do not assume a source-code repository backs up application data.`,
      `3. Run ${ref("POST", "/api/backup-policies/:policyId/run")}. Follow EVERY returned runId/runIds with ${ref("GET", "/api/backup-runs/:runId")}. A queued/running job is not a usable backup. Read history with ${ref("GET", "/api/projects/:projectId/backup-runs")}; query.before continues before the last run in the previous page. Protect a recovery point from retention with ${ref("POST", "/api/backup-runs/:runId/protect")} when needed.`,
      `4. Restore starts with ${ref("POST", "/api/backup-runs/:runId/restore/prepare")}. Keep restoreId and confirmationToken. Poll ${ref("GET", "/api/backup-restores/:restoreId")} until prepared and review the target/mode. Preparation does not apply data.`,
      `5. Apply only the reviewed restore with ${ref("POST", "/api/backup-restores/:restoreId/apply")} and confirmationToken, then poll status through completion. In-place apply can stop services and overwrite data. ${ref("POST", "/api/backup-restores/:restoreId/cancel")} requests cancellation; it cannot undo already-written data. Verify application health after restoration.`,
    ].join("\n\n"),
  },
  {
    name: "migrate-docker-project",
    title: "Migrate Docker workloads with verified cutover",
    description: "Discover/adopt existing containers or move an Openship project, preserving environment/data and explicitly handling partial transfers and cutover.",
    localOnly: true,
    build: (_args, ref) => [
      `1. Discover servers, then ${ref("POST", "/api/migration/scan")} on the source. Select container IDs from that scan to distinguish services with the same name in different Compose groups. Secrets are masked; the server rediscovers real source values. Never submit masked values as replacement secrets.`,
      `2. Inspect repository Compose configuration with ${ref("POST", "/api/migration/repo-compose")} if linking a repo. Review service mapping, environment overrides, volumes and routes, then ${ref("POST", "/api/migration/preview")} with the same selected services and destination.`,
      `3. Start ${ref("POST", "/api/migration/migrate")} and keep migrationId and confirmationToken. Leave killOriginals:false to pause for explicit cutover; true authorizes automatic destruction of original containers after verification. Existing Openship projects use ${ref("POST", "/api/migration/project")} for move/copy instead. These tools move Docker workloads, not live k3s databases.`,
      `4. Poll ${ref("GET", "/api/migration/migrations/:id")}. Respond only to the returned pendingPrompt using ${ref("POST", "/api/migration/migrations/:id/respond")} and its prompt/action IDs. Partial transfers use ${ref("POST", "/api/migration/migrations/:id/resume")} after reviewing failed paths; skipping a path excludes its data.`,
      `5. At awaiting_cutover, verify target deployment, saved environment, volumes, routes and health. Confirm with ${ref("POST", "/api/migration/migrations/:id/cutover")} and the confirmationToken; kill:false retains originals stopped, while kill:true deletes them. Re-read status to confirm completion.`,
      `6. Before cutover, ${ref("POST", "/api/migration/migrations/:id/cancel")} requests rollback. For a failed migration, ${ref("POST", "/api/migration/migrations/:id/cleanup-target")} removes copied target data; inspect ownership and failure state first. Deleting a terminal migration record removes history only.`,
    ].join("\n\n"),
  },
];

/** Client-facing `prompts/list` descriptors. */
export function listPrompts() {
  return PROMPTS.filter((p) => !p.localOnly || !env.CLOUD_MODE).map((p) => ({
    name: p.name,
    title: p.title,
    description: p.description,
    ...(p.arguments ? { arguments: p.arguments } : {}),
  }));
}

/**
 * Build a `prompts/get` result for one prompt, or null if the name is unknown.
 * Returns a single user-role message carrying the resolved guidance.
 */
export function getPrompt(
  name: string,
  args: Record<string, string>,
): { description: string; messages: unknown[] } | null {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt || (prompt.localOnly && env.CLOUD_MODE)) return null;
  const text = `${workspaceInstructions()}\n\n${prompt.build(args ?? {}, toolRef)}\n\n${BUG_REPORT}`;
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

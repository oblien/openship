import { getMcpTools } from "./mcp-tools";

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
  /** Build the guidance body. `ref(method, path)` → the tool's generated name. */
  build: (args: Record<string, string>, ref: (method: string, path: string) => string) => string;
}

/** Resolve a route (method + full path) to its generated MCP tool name. */
function toolRef(method: string, path: string): string {
  const t = getMcpTools().find((x) => x.method === method && x.path === path);
  return t ? t.name : `${method} ${path}`;
}

/**
 * Appended to every prompt: if the agent hits something that looks like an
 * Openship platform bug (not a user-input error), it should point the user at
 * the issue tracker rather than silently working around it.
 */
const BUG_REPORT =
  "If you hit what looks like a bug in Openship itself — an unexpected 500, a tool that misbehaves, or a deploy that fails for a platform reason rather than your input — tell the user to open an issue at https://github.com/oblien/openship/issues, including the tool name, the arguments you sent, and any error text returned.";

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
        "- Domains, jobs, webhooks, notifications, analytics, backups — read history and change config.",
        "",
        "Guided flows (fetch these prompts for step-by-step chains):",
        "- `deploy-from-git` — deploy a GitHub/linked repo.",
        "- `deploy-a-folder` — deploy a local source folder (has an out-of-band upload step).",
        "- `install-catalog-app` — install a one-click app.",
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
        `4. Deploy: ${ref("POST", "/api/deployments/build/access")} with the projectId from step 3. Optional wizard settings: envVars, publicEndpoints (omit to auto-derive a free subdomain), buildStrategy, runtimeMode, cloudResourceTier. Do NOT set deployTarget:'cloud' on a self-hosted instance. To redeploy an already-linked project later, ${ref("POST", "/api/deployments")} is the shortcut.`,
        `5. Watch it: poll ${ref("GET", "/api/deployments/:id")} for status/urls and ${ref("GET", "/api/deployments/:id/logs")} for build/runtime logs.`,
        `6. A deploy can STOP AND ASK — it is not always running or finished. If it seems stuck, or ends up \`action_required\`, call ${ref("GET", "/api/deployments/:id/pending")}. A held deploy is waiting on a decision (e.g. the port is already in use) and will ABORT on its own at the item's \`expiresAt\`; answer it with ${ref("POST", "/api/deployments/:id/build/respond")} using an action id from that item's \`resolveWith\` — never an id you guessed. Other items there resolve the same way, each carrying the exact call to make. ${ref("GET", "/api/projects/:id/pending-actions")} is the whole-project version (also covers domains, certificates and routing) — worth a look before reporting a deploy as simply failed.`,
      ].join("\n");
    },
  },
  {
    name: "deploy-a-folder",
    title: "Deploy a local source folder (upload)",
    description:
      "The 4-step folder-upload flow. Note step 1b: the raw tarball upload is NOT an MCP tool — you POST the bytes yourself with an HTTP client.",
    build: (_args, ref) =>
      [
        "Deploy a local folder that isn't in git. This flow has an out-of-band byte upload — raw binary can't cross JSON-RPC, so you upload the tarball yourself.",
        "",
        `1. Open an upload session: ${ref("POST", "/api/projects/folder/session")}. It returns \`upload\` = { url, absoluteUrl, method, headers, requiresAuth } and a sessionId.`,
        "1b. OUT OF BAND — gzip your folder into a tarball and POST the bytes to `upload.absoluteUrl` (the ready-to-use URL; `upload.url` is the same target relative to your API base) with the returned headers and Content-Type: application/gzip, plus your `Authorization: Bearer <token>` when `upload.requiresAuth` is true. Use a plain HTTP client; there is no MCP tool for this.",
        `2. Detect the uploaded source's stack: ${ref("POST", "/api/projects/folder/scan/:sessionId")} (body may be {}). Returns framework, package manager, install/build/start commands, output dir, port — plus a \`services\` array for a docker-compose folder.`,
        `3. Create/update the project that carries the build config: ${ref("POST", "/api/projects/ensure")}. Map the scan fields in (framework = the scan's stack id) and set gitProvider:'upload'. If the scan returned \`services\`, pass that array through verbatim AND include \`uploadSessionId\` — env values come back masked ("••••••••"), and the session is what restores the real ones. Returns the project id.`,
        `4. Deploy: ${ref("POST", "/api/deployments/build/access")} with the projectId (step 3) and uploadSessionId (step 1). Then watch with ${ref("GET", "/api/deployments/:id")} and ${ref("GET", "/api/deployments/:id/logs")}.`,
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
];

/** Client-facing `prompts/list` descriptors. */
export function listPrompts() {
  return PROMPTS.map((p) => ({
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
  if (!prompt) return null;
  const text = `${prompt.build(args ?? {}, toolRef)}\n\n${BUG_REPORT}`;
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

/**
 * `openship project` — project lifecycle grounded in
 * apps/api/src/modules/projects/project.routes.ts (mounted at /api/projects).
 *
 * One parent Command with subcommands; each subcommand hits exactly one route.
 * Endpoint citations live on the relevant action.
 */
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { apiRequest, paginate, ApiError } from "../lib/api-client";
import { sseRequest } from "../lib/sse";
import { fetchCaps, requireSelfHost } from "../lib/caps";
import { isJsonMode, printJson, printTable, ok, err, info } from "../lib/output";
import {
  renderReleaseImage,
  validateReleaseRepository,
  validateReleaseVersionUrl,
  type ReleaseSource,
} from "@repo/core";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Wrap an action so ApiError (and anything else) prints cleanly and sets exit code. */
function action(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) err(`  ${e.message}`);
      else err(`  ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  };
}

/** Render a single project: raw JSON in --json mode, a short field block otherwise. */
function printProject(project: Record<string, unknown>): void {
  if (isJsonMode()) {
    printJson(project);
    return;
  }
  const fields: [string, unknown][] = [
    ["id", project.id],
    ["name", project.name],
    ["slug", project.slug],
    ["framework", project.framework],
    [
      "gitRepo",
      project.gitOwner && project.gitRepo ? `${project.gitOwner}/${project.gitRepo}` : null,
    ],
    ["gitBranch", project.gitBranch],
    ["autoDeploy", project.autoDeploy],
    ["status", project.status],
  ];
  for (const [k, v] of fields) {
    if (v === null || v === undefined || v === "") continue;
    process.stdout.write(`  ${chalk.dim(k.padEnd(12))} ${String(v)}\n`);
  }
}

const ENVIRONMENTS = ["production", "preview", "development"];

interface ReleaseImageOptions {
  imageTemplate: string;
  githubRepo?: string;
  versionUrl?: string;
  pin?: string;
}

/** Build the complete source-transition payload before touching the API. */
export function releaseImageSourceFromOptions(opts: ReleaseImageOptions): ReleaseSource {
  const imageTemplate = opts.imageTemplate.trim();
  const repo = opts.githubRepo?.trim() || undefined;
  const versionUrl = opts.versionUrl?.trim() || undefined;
  const pinnedVersion = opts.pin?.trim() || undefined;
  const validationTag = pinnedVersion ?? "v1.2.3";
  renderReleaseImage(imageTemplate, {
    version: validationTag.replace(/^v/i, ""),
    tag: validationTag,
  });

  // Repository and external URL are competing discovery modes. A pin is valid
  // for either mode: it intentionally overrides discovery without discarding
  // where future/latest releases come from when the pin is later removed.
  if (repo && versionUrl) {
    throw new Error("--github-repo cannot be combined with --version-url.");
  }
  if (repo) {
    const invalidRepo = validateReleaseRepository(repo);
    if (invalidRepo)
      throw new Error(invalidRepo.replace("GitHub release repository", "--github-repo"));
    return {
      artifactKind: "image",
      mode: "github",
      imageTemplate,
      repo,
      ...(pinnedVersion ? { pinnedVersion } : {}),
    };
  }

  if (!versionUrl && !pinnedVersion) {
    throw new Error("Pass --github-repo, --version-url, or --pin.");
  }
  if (versionUrl) {
    const invalidUrl = validateReleaseVersionUrl(versionUrl);
    if (invalidUrl) throw new Error(invalidUrl.replace("Release version URL", "--version-url"));
  }

  return {
    artifactKind: "image",
    mode: "url",
    imageTemplate,
    ...(versionUrl ? { versionUrl } : {}),
    ...(pinnedVersion ? { pinnedVersion } : {}),
  };
}

// ─── list ────────────────────────────────────────────────────────────────────
// GET /api/projects → { data, total, page, perPage } (project.routes.ts:46)
const listCmd = new Command("list")
  .alias("ls")
  .description("List projects in the active organization")
  .action(
    action(async () => {
      const rows: Record<string, unknown>[] = [];
      for await (const p of paginate<Record<string, unknown>>("/projects")) {
        rows.push({
          id: p.id,
          name: p.name,
          slug: p.slug,
          repo: p.gitOwner && p.gitRepo ? `${p.gitOwner}/${p.gitRepo}` : "",
          source: p.source ?? "local",
        });
      }
      printTable(rows, ["id", "name", "slug", "repo", "source"]);
    }),
  );

// ─── get ─────────────────────────────────────────────────────────────────────
// GET /api/projects/:id → { data } (project.routes.ts:50)
const getCmd = new Command("get")
  .description("Show a single project")
  .argument("<id>", "Project ID")
  .action(
    action(async (id: string) => {
      const { data } = await apiRequest<{ data: Record<string, unknown> }>(
        `/projects/${encodeURIComponent(id)}`,
      );
      printProject(data);
    }),
  );

// ─── release-image ───────────────────────────────────────────────────────────
// PUT /api/projects/:id/release-image-source — atomic source transition.
const releaseImageCmd = new Command("release-image")
  .description("Track and deploy a versioned prebuilt container image")
  .argument("<id>", "Project ID")
  .requiredOption(
    "--image-template <reference>",
    "Image reference with {tag} or {version}, e.g. ghcr.io/acme/api:{tag}",
  )
  .option("--github-repo <owner/repo>", "Resolve versions from GitHub Releases")
  .option("--version-url <https-url>", "HTTPS endpoint returning a version or tag")
  .option("--pin <version>", "Deploy a fixed version instead of the discovered latest release")
  .action(
    action(async (id: string, opts: ReleaseImageOptions) => {
      const source = releaseImageSourceFromOptions(opts);
      const result = await apiRequest<{ data: Record<string, unknown> }>(
        `/projects/${encodeURIComponent(id)}/release-image-source`,
        { method: "PUT", body: JSON.stringify(source) },
      );
      if (isJsonMode()) {
        printJson(result.data);
        return;
      }
      const upstream =
        source.mode === "github"
          ? `GitHub Releases (${source.repo})`
          : source.versionUrl
            ? `version URL (${source.versionUrl})`
            : `pinned version (${source.pinnedVersion})`;
      ok(`\n  Project ${id} now deploys ${source.imageTemplate} from ${upstream}\n`);
    }),
  );

// ─── create ──────────────────────────────────────────────────────────────────
// POST /api/projects → { data } 201 (project.routes.ts:47, body = CreateProjectBody)
const createCmd = new Command("create")
  .description("Create a project")
  .requiredOption("--name <name>", "Project name")
  .option("--slug <slug>", "Free-subdomain slug (slug.opsh.io)")
  .option("--git-owner <owner>", "GitHub owner/org")
  .option("--git-repo <repo>", "GitHub repository name")
  .option("--git-branch <branch>", "Git branch to deploy")
  .option("--framework <framework>", "Stack/framework id")
  .option("--local-path <path>", "Local source path")
  .option("--port <port>", "Container port", (v) => Number(v))
  .option("--type <type>", "Project type: app | docker | services | monorepo")
  .action(
    action(async (opts) => {
      const body: Record<string, unknown> = { name: opts.name };
      if (opts.slug) body.slug = opts.slug;
      if (opts.gitOwner) body.gitOwner = opts.gitOwner;
      if (opts.gitRepo) body.gitRepo = opts.gitRepo;
      if (opts.gitBranch) body.gitBranch = opts.gitBranch;
      if (opts.framework) body.framework = opts.framework;
      if (opts.localPath) body.localPath = opts.localPath;
      if (opts.port) body.port = opts.port;
      if (opts.type) body.projectType = opts.type;

      const { data } = await apiRequest<{ data: Record<string, unknown> }>("/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });
      ok(`\n  Created project ${data.name} (${data.id})\n`);
      printProject(data);
    }),
  );

// ─── delete ──────────────────────────────────────────────────────────────────
// DELETE /api/projects/:id?force=&wipeVolumes=&forceOrphan= (project.routes.ts:52)
const deleteCmd = new Command("delete")
  .alias("rm")
  .description("Delete a project (tears down all resources)")
  .argument("<id>", "Project ID")
  .option("--force", "Cancel active work and delete anyway")
  .option("--force-orphan", "Orphan resources that won't destroy, then drop the row")
  .option("--wipe-volumes", "Also destroy persistent volumes")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(
    action(async (id: string, opts) => {
      if (!opts.yes) {
        const rl = createInterface({ input, output });
        const answer = await rl.question(
          chalk.yellow(`  Delete project ${id}? This cannot be undone. `) + "(y/N) ",
        );
        rl.close();
        if (answer.trim().toLowerCase() !== "y") {
          info("  Aborted.");
          return;
        }
      }
      const query = new URLSearchParams();
      if (opts.force) query.set("force", "true");
      if (opts.forceOrphan) query.set("forceOrphan", "true");
      if (opts.wipeVolumes) query.set("wipeVolumes", "true");
      const qs = query.toString();
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
        { method: "DELETE" },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(`\n  ${(result.message as string) ?? "deleted"}\n`);
    }),
  );

// ─── env (group) ───────────────────────────────────────────────────────────────
const envCmd = new Command("env").description("Manage project environment variables");

// GET /api/projects/:id/env?environment= → { data } (project.routes.ts:72)
envCmd
  .command("get")
  .description("List env vars (secret values are masked by the API)")
  .argument("<id>", "Project ID")
  .option("--environment <env>", "Filter by environment (production|preview|development)")
  .action(
    action(async (id: string, opts) => {
      const qs = opts.environment ? `?environment=${encodeURIComponent(opts.environment)}` : "";
      const { data } = await apiRequest<{ data: Record<string, unknown>[] }>(
        `/projects/${encodeURIComponent(id)}/env${qs}`,
      );
      printTable(
        data.map((v) => ({
          key: v.key,
          value: v.value,
          environment: v.environment,
          secret: v.isSecret,
        })),
        ["key", "value", "environment", "secret"],
      );
    }),
  );

// PATCH /api/projects/:id/env → merge { environment, upserts[], deletes[] } (project.routes.ts:76)
envCmd
  .command("set")
  .description("Merge env vars: upsert KEY=VALUE pairs and/or delete keys")
  .argument("<id>", "Project ID")
  .option("--environment <env>", "Target environment", "production")
  .option(
    "--set <pair>",
    "KEY=VALUE to upsert (repeatable)",
    (val: string, acc: string[] = []) => {
      acc.push(val);
      return acc;
    },
    [] as string[],
  )
  .option(
    "--unset <key>",
    "KEY to delete (repeatable)",
    (val: string, acc: string[] = []) => {
      acc.push(val);
      return acc;
    },
    [] as string[],
  )
  .option("--secret", "Mark every --set value as a secret")
  .action(
    action(async (id: string, opts) => {
      if (!ENVIRONMENTS.includes(opts.environment)) {
        err(`  environment must be one of: ${ENVIRONMENTS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const upserts = (opts.set as string[]).map((pair) => {
        const eq = pair.indexOf("=");
        if (eq === -1) throw new Error(`--set expects KEY=VALUE, got "${pair}"`);
        return {
          key: pair.slice(0, eq),
          value: pair.slice(eq + 1),
          isSecret: !!opts.secret,
        };
      });
      const deletes = opts.unset as string[];
      if (upserts.length === 0 && deletes.length === 0) {
        err("  Nothing to do — pass --set and/or --unset.");
        process.exitCode = 1;
        return;
      }
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/env`,
        {
          method: "PATCH",
          body: JSON.stringify({ environment: opts.environment, upserts, deletes }),
        },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(
        `\n  Updated env (${opts.environment}): ${upserts.length} upserted, ${deletes.length} deleted\n`,
      );
    }),
  );

// ─── git (group) ─────────────────────────────────────────────────────────────
const gitCmd = new Command("git").description("Manage git linkage and auto-deploy");

// POST /api/projects/:id/git/link { owner, repo, branch?, installationId? } (project.routes.ts:85)
gitCmd
  .command("link")
  .description("Link a GitHub repository to a project")
  .argument("<id>", "Project ID")
  .requiredOption("--owner <owner>", "GitHub owner/org")
  .requiredOption("--repo <repo>", "Repository name")
  .option("--branch <branch>", "Branch (defaults to the repo's default branch)")
  .option("--installation-id <id>", "GitHub App installation id", (v) => Number(v))
  .action(
    action(async (id: string, opts) => {
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/git/link`,
        {
          method: "POST",
          body: JSON.stringify({
            owner: opts.owner,
            repo: opts.repo,
            branch: opts.branch,
            installationId: opts.installationId,
          }),
        },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(
        `\n  Linked ${result.owner}/${result.repo} @ ${result.branch} ` +
          `(webhook: ${result.webhook_strategy}, auto-deploy: ${result.auto_deploy})\n`,
      );
    }),
  );

// POST /api/projects/:id/branch { branch } (project.routes.ts:89)
gitCmd
  .command("branch")
  .description("Set the deploy branch")
  .argument("<id>", "Project ID")
  .argument("<branch>", "Branch name")
  .action(
    action(async (id: string, branch: string) => {
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/branch`,
        { method: "POST", body: JSON.stringify({ branch }) },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(`\n  Branch set to ${branch}\n`);
    }),
  );

// POST /api/projects/:id/auto-deploy { enabled } (project.routes.ts:87)
gitCmd
  .command("auto-deploy")
  .description("Enable or disable push-to-deploy")
  .argument("<id>", "Project ID")
  .option("--enable", "Enable auto-deploy")
  .option("--disable", "Disable auto-deploy")
  .action(
    action(async (id: string, opts) => {
      if (opts.enable === opts.disable) {
        err("  Pass exactly one of --enable or --disable.");
        process.exitCode = 1;
        return;
      }
      const enabled = !!opts.enable;
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/auto-deploy`,
        { method: "POST", body: JSON.stringify({ enabled }) },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(
        `\n  Auto-deploy ${result.auto_deploy ? "enabled" : "disabled"} ` +
          `(strategy: ${result.webhook_strategy})\n`,
      );
    }),
  );

// POST /api/projects/:id/webhook-domain { domain: string | null } (project.routes.ts:88)
gitCmd
  .command("webhook-domain")
  .description("Set or clear the domain that receives GitHub webhooks")
  .argument("<id>", "Project ID")
  .argument("[domain]", "Verified project domain (omit with --clear to unset)")
  .option("--clear", "Clear the webhook domain")
  .action(
    action(async (id: string, domain: string | undefined, opts) => {
      if (!opts.clear && !domain) {
        err("  Provide a domain, or pass --clear to unset.");
        process.exitCode = 1;
        return;
      }
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/webhook-domain`,
        {
          method: "POST",
          body: JSON.stringify({ domain: opts.clear ? null : domain }),
        },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      if (opts.clear) ok("\n  Webhook domain cleared\n");
      else ok(`\n  Webhook domain set to ${result.webhook_domain} → ${result.webhook_url}\n`);
    }),
  );

// ─── connect ─────────────────────────────────────────────────────────────────
// POST /api/projects/:id/connect { domain, includeWww? } (project.routes.ts:104)
const connectCmd = new Command("connect")
  .description("Connect a custom domain to a project")
  .argument("<id>", "Project ID")
  .argument("<domain>", "Custom domain hostname")
  .option("--include-www", "Also connect the www. variant")
  .action(
    action(async (id: string, domain: string, opts) => {
      const result = await apiRequest<{ domain: Record<string, unknown>; records: unknown }>(
        `/projects/${encodeURIComponent(id)}/connect`,
        {
          method: "POST",
          body: JSON.stringify({ domain, includeWww: !!opts.includeWww }),
        },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(`\n  Connected ${result.domain.hostname}\n`);
      info("  Add the DNS records below, then verification runs automatically:");
      printJson(result.records);
    }),
  );

// ─── enable / disable ──────────────────────────────────────────────────────────
// POST /api/projects/:id/enable | /disable (project.routes.ts:62-63)
const enableCmd = new Command("enable")
  .description("Start a stopped project")
  .argument("<id>", "Project ID")
  .action(
    action(async (id: string) => {
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/enable`,
        { method: "POST" },
      );
      if (isJsonMode()) printJson(result);
      else ok(`\n  Project enabled\n`);
    }),
  );

const disableCmd = new Command("disable")
  .description("Stop a running project")
  .argument("<id>", "Project ID")
  .action(
    action(async (id: string) => {
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/disable`,
        { method: "POST" },
      );
      if (isJsonMode()) printJson(result);
      else ok(`\n  Project disabled\n`);
    }),
  );

// ─── sleep-mode ────────────────────────────────────────────────────────────────
// POST /api/projects/:id/sleep-mode { sleep_mode } (project.routes.ts:97)
const SLEEP_MODES = ["auto_sleep", "always_on"];
const sleepModeCmd = new Command("sleep-mode")
  .description("Set the project sleep mode")
  .argument("<id>", "Project ID")
  .argument("<mode>", `One of: ${SLEEP_MODES.join(", ")}`)
  .action(
    action(async (id: string, mode: string) => {
      if (!SLEEP_MODES.includes(mode)) {
        err(`  mode must be one of: ${SLEEP_MODES.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/sleep-mode`,
        { method: "POST", body: JSON.stringify({ sleep_mode: mode }) },
      );
      if (isJsonMode()) printJson(result);
      else ok(`\n  Sleep mode set to ${mode}\n`);
    }),
  );

// ─── transfer ────────────────────────────────────────────────────────────────
// POST /api/projects/:id/transfer/to-cloud | to-self-hosted — self-hosted ONLY
// (project.routes.ts:119-120, localOnly). Gate with requireSelfHost.
const TRANSFER_DIRS = ["to-cloud", "to-self-hosted"];
const transferCmd = new Command("transfer")
  .description("Promote a project to Openship Cloud, or bring it back (self-hosted only)")
  .argument("<id>", "Project ID")
  .argument("<direction>", `One of: ${TRANSFER_DIRS.join(", ")}`)
  .action(
    action(async (id: string, direction: string) => {
      if (!TRANSFER_DIRS.includes(direction)) {
        err(`  direction must be one of: ${TRANSFER_DIRS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      requireSelfHost(await fetchCaps());
      const result = await apiRequest<Record<string, unknown>>(
        `/projects/${encodeURIComponent(id)}/transfer/${direction}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      ok(
        `\n  Transfer ${direction} complete (project ${result.projectId})` +
          (result.warning ? `\n  ${result.warning}` : "") +
          "\n",
      );
    }),
  );

// ─── logs ────────────────────────────────────────────────────────────────────
// GET /api/projects/:id/logs?tail= → { data } ;
// GET /api/projects/:id/logs/stream (SSE: event "log" | "error") (project.routes.ts:107-108)
const logsCmd = new Command("logs")
  .description("Show or stream runtime (container) logs")
  .argument("<id>", "Project ID")
  .option("--tail <n>", "Number of recent lines", (v) => Number(v))
  .option("-f, --follow", "Stream logs until interrupted")
  .action(
    action(async (id: string, opts) => {
      const tailQs = opts.tail ? `?tail=${opts.tail}` : "";
      if (!opts.follow) {
        const { data } = await apiRequest<{ data: Record<string, unknown>[] }>(
          `/projects/${encodeURIComponent(id)}/logs${tailQs}`,
        );
        if (isJsonMode()) {
          printJson(data);
          return;
        }
        for (const entry of data) printLogEntry(entry);
        return;
      }

      for await (const ev of sseRequest(
        `/projects/${encodeURIComponent(id)}/logs/stream${tailQs}`,
      )) {
        if (ev.event === "error") {
          const parsed = safeParse(ev.data);
          err(`  ${(parsed?.error as string) ?? ev.data}`);
          process.exitCode = 1;
          return;
        }
        if (ev.event === "log") {
          const parsed = safeParse(ev.data);
          if (parsed) printLogEntry(parsed);
        }
      }
    }),
  );

// ─── server-logs ───────────────────────────────────────────────────────────────
// GET /api/projects/:id/server-logs/recent?limit=&domain= → { logs } ;
// GET /api/projects/:id/server-logs/stream-token → { kind } ;
// GET /api/projects/:id/server-logs/stream (SSE, self-hosted only)
// (project.routes.ts:111-113)
const serverLogsCmd = new Command("server-logs")
  .description("Show or stream HTTP request logs (edge/OpenResty)")
  .argument("<id>", "Project ID")
  .option("--limit <n>", "Number of recent entries (max 200)", (v) => Number(v))
  .option("--domain <domain>", "Restrict to a specific domain")
  .option("-f, --follow", "Stream request logs until interrupted")
  .action(
    action(async (id: string, opts) => {
      const base = `/projects/${encodeURIComponent(id)}/server-logs`;
      const domainQs = opts.domain ? `domain=${encodeURIComponent(opts.domain)}` : "";

      if (!opts.follow) {
        const q = [opts.limit ? `limit=${opts.limit}` : "", domainQs].filter(Boolean).join("&");
        const { logs } = await apiRequest<{ logs: unknown[] }>(`${base}/recent${q ? `?${q}` : ""}`);
        printJson(logs);
        return;
      }

      // Streaming path branches on deployment shape. Cloud projects mint an edge
      // token the browser connects to directly — not yet wired in the CLI — so we
      // only follow self-hosted OpenResty streams here.
      const token = await apiRequest<{ kind: string }>(
        `${base}/stream-token${domainQs ? `?${domainQs}` : ""}`,
      );
      if (token.kind === "cloud") {
        info("  Cloud server-log streaming is coming soon — view it in the dashboard.");
        info("  Showing recent entries instead:");
        const { logs } = await apiRequest<{ logs: unknown[] }>(
          `${base}/recent${domainQs ? `?${domainQs}` : ""}`,
        );
        printJson(logs);
        return;
      }

      for await (const ev of sseRequest(`${base}/stream${domainQs ? `?${domainQs}` : ""}`)) {
        if (ev.event === "error") {
          const parsed = safeParse(ev.data);
          err(`  ${(parsed?.error as string) ?? ev.data}`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(ev.data + "\n");
      }
    }),
  );

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function printLogEntry(entry: Record<string, unknown>): void {
  const ts = entry.timestamp ? chalk.dim(String(entry.timestamp)) : "";
  const level = String(entry.level ?? "info");
  const color = level === "error" ? chalk.red : level === "warn" ? chalk.yellow : chalk.dim;
  const msg = entry.message ?? entry.data ?? "";
  process.stdout.write(`  ${ts} ${color(level.padEnd(5))} ${String(msg)}\n`);
}

// ─── parent ────────────────────────────────────────────────────────────────────
export const projectCommand = new Command("project")
  .alias("projects")
  .description("Manage Openship projects");

projectCommand.addCommand(listCmd);
projectCommand.addCommand(getCmd);
projectCommand.addCommand(releaseImageCmd);
projectCommand.addCommand(createCmd);
projectCommand.addCommand(deleteCmd);
projectCommand.addCommand(envCmd);
projectCommand.addCommand(gitCmd);
projectCommand.addCommand(connectCmd);
projectCommand.addCommand(enableCmd);
projectCommand.addCommand(disableCmd);
projectCommand.addCommand(sleepModeCmd);
projectCommand.addCommand(transferCmd);
projectCommand.addCommand(logsCmd);
projectCommand.addCommand(serverLogsCmd);

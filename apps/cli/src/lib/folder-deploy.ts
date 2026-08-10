/**
 * Folder (non-git) deploy for the CLI — the terminal equivalent of the MCP /
 * dashboard folder-upload flow. When `openship deploy` runs outside a git repo,
 * we package the current folder and drive the same server-side pipeline:
 *
 *   folder/session → (upload the tar.gz) → folder/scan → projects/ensure →
 *   deployments/build/access
 *
 * Unlike MCP (which can't carry binary over JSON-RPC), the CLI uploads the
 * tarball itself. The upload target is server-owned and opaque: an absolute
 * Oblien workspace URL on the cloud, or an API-relative relay path when
 * self-hosted — we handle both.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { apiRequest, apiRaw } from "./api-client";

interface UploadTarget {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}
interface FolderSessionRes {
  success?: boolean;
  sessionId?: string;
  upload?: UploadTarget;
  error?: string;
}
interface ScanRes {
  success?: boolean;
  name?: string;
  stack?: string;
  projectType?: string;
  packageManager?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  buildImage?: string;
  outputDirectory?: string;
  rootDirectory?: string;
  port?: number;
  /** Compose / multi-service definitions the scan detected. Forwarded to
   *  build/access so the project is deployed as a SERVICES project (rows synced,
   *  preflight uses the services branch — not single-app "missing build image"),
   *  and so per-service scoping (--service-ids) has real rows to act on. */
  services?: Array<Record<string, unknown>>;
  error?: string;
}
interface EnsureRes {
  success?: boolean;
  project_id?: string;
  error?: string;
}
interface BuildAccessRes {
  success?: boolean;
  deployment_id?: string;
  project_id?: string;
  error?: string;
}

/** Lockfile → package manager. Server scan is authoritative; this is just a
 *  hint so the upload workspace picks a sensible base image. */
function detectPackageManager(dir: string): string | undefined {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package.json"))) return "npm";
  return undefined;
}

/** Manifest → coarse stack hint (server scan re-detects the real framework). */
function detectStack(dir: string): string | undefined {
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust";
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"))) return "python";
  if (existsSync(join(dir, "package.json"))) return "node";
  return undefined;
}

export interface FolderDeployResult {
  deploymentId?: string;
  projectId?: string;
}

export async function deployFolder(opts: {
  cwd: string;
  name?: string;
  /** Reuse/update an existing project instead of creating one. */
  projectId?: string;
  environment?: string;
  /** Scope a folder REDEPLOY to a subset of services; others carry forward
   *  untouched (no needless stateful recreate). Ignored on a first deploy. */
  serviceIds?: string[];
  onStep?: (message: string) => void;
}): Promise<FolderDeployResult> {
  const { cwd } = opts;
  const step = opts.onStep ?? (() => {});
  const name = opts.name || basename(cwd) || "app";

  // 1. Open an upload session (also provisions the cloud workspace).
  step("Creating upload session");
  const session = await apiRequest<FolderSessionRes>("/projects/folder/session", {
    method: "POST",
    body: JSON.stringify({ name, packageManager: detectPackageManager(cwd), stack: detectStack(cwd) }),
  });
  if (!session.sessionId || !session.upload) {
    throw new Error(session.error || "Failed to open upload session");
  }

  // 2. Package the folder (source only — deps are reinstalled during build).
  step("Packaging folder");
  const tarball = join(tmpdir(), `openship-upload-${session.sessionId}.tar.gz`);
  execFileSync(
    "tar",
    [
      "-czf",
      tarball,
      "--exclude=./node_modules",
      "--exclude=./.git",
      "--exclude=./dist",
      "--exclude=./.next",
      "--exclude=./.DS_Store",
      "-C",
      cwd,
      ".",
    ],
    { stdio: "ignore" },
  );

  // 3. Upload the tarball to the server-owned target. Absolute URL → cloud
  //    workspace (send as-is with its token headers); relative → self-hosted
  //    relay (apiRaw prepends the API base + Bearer auth).
  step("Uploading source");
  try {
    const body = readFileSync(tarball);
    const up = session.upload;
    const method = up.method || "POST";
    const res = /^https?:\/\//i.test(up.url)
      ? await fetch(up.url, { method, headers: up.headers, body })
      : await apiRaw(`/${up.url.replace(/^\/+/, "")}`, { method, headers: up.headers, body });
    if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
  } finally {
    try {
      rmSync(tarball, { force: true });
    } catch {
      /* temp file — best-effort cleanup */
    }
  }

  // 4. Authoritative framework/build detection on the uploaded source.
  step("Detecting build config");
  const scan = await apiRequest<ScanRes>(`/projects/folder/scan/${session.sessionId}`, {
    method: "POST",
    body: "{}",
  });
  if (scan.success === false) throw new Error(scan.error || "Failed to scan uploaded source");

  // 5. Create (or update) the project from the scan. A start command means a
  //    long-running server; its absence means a static site served from the edge.
  step("Creating project");
  const hasBuild = Boolean(scan.buildCommand);
  const hasServer = Boolean(scan.startCommand);
  const ensured = await apiRequest<EnsureRes>("/projects/ensure", {
    method: "POST",
    body: JSON.stringify({
      projectId: opts.projectId,
      name: scan.name || name,
      gitProvider: "upload",
      framework: scan.stack,
      projectType: scan.projectType,
      packageManager: scan.packageManager,
      installCommand: scan.installCommand,
      buildCommand: scan.buildCommand,
      startCommand: scan.startCommand || undefined,
      outputDirectory: scan.outputDirectory,
      rootDirectory: scan.rootDirectory,
      buildImage: scan.buildImage,
      hasBuild,
      hasServer,
      productionMode: hasServer ? "standalone" : "static",
      ...(hasServer && scan.port ? { port: scan.port } : {}),
    }),
  });
  if (!ensured.project_id) throw new Error(ensured.error || "Failed to create project");

  // 6. Deploy the uploaded source. Omitting publicEndpoints lets the server
  //    auto-bind a free subdomain from the project slug.
  step("Deploying");
  const dep = await apiRequest<BuildAccessRes>("/deployments/build/access", {
    method: "POST",
    body: JSON.stringify({
      projectId: ensured.project_id,
      uploadSessionId: session.sessionId,
      ...(opts.environment ? { environment: opts.environment } : {}),
      // Carry the scanned compose services so a multi-service folder deploys as
      // a services project (persisted rows + services-mode preflight). Absent for
      // single-app folders, so their path is unchanged.
      ...(scan.services && scan.services.length > 0 ? { services: scan.services } : {}),
      // Scope a redeploy to a subset of services (others carry forward untouched).
      ...(opts.serviceIds && opts.serviceIds.length > 0 ? { serviceIds: opts.serviceIds } : {}),
    }),
  });
  if (!dep.deployment_id) throw new Error(dep.error || "Failed to start deployment");

  return { deploymentId: dep.deployment_id, projectId: dep.project_id };
}

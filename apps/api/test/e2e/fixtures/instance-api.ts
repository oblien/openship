import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
export interface RunningApi {
  child: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  dbDir: string;
  port: number;
  secret: string;
  logs: () => string;
}
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const API_ENTRY = resolve(REPO_ROOT, "apps/api/src/index.ts");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForApi(api: RunningApi): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) {
      throw new Error(`API exited during startup (${api.child.exitCode})\n${api.logs()}`);
    }
    try {
      const response = await fetch(`${api.baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`API did not become ready on ${api.baseUrl}\n${api.logs()}`);
}

export async function startApi(input: {
  dbDir: string;
  port: number;
  secret: string;
  authMode?: "none" | "local";
  apiOnly?: boolean;
  cloudMode?: boolean;
  environment?: Record<string, string>;
  entry?: string;
  runtime?: "bun" | "node";
  dashboardOrigin?: string;
  publicUrl?: string;
}): Promise<RunningApi> {
  let output = "";
  await mkdir(input.dbDir, { recursive: true });
  const child = spawn(input.runtime ?? "bun", [input.entry ?? API_ENTRY], {
    // Run outside the checkout so Bun cannot load a developer's .env. Only
    // process-launch settings are inherited; never live provider credentials.
    cwd: input.dbDir,
    env: {
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG", "SHELL"].map((key) => [key, process.env[key]]),
      ),
      ...input.environment,
      // Do not inherit Vitest's marker: @repo/db intentionally switches to an
      // in-memory PGlite under VITEST, which would make a process restart look
      // like data loss instead of reopening the explicit directory below.
      VITEST: "",
      NODE_ENV: "production",
      DEPLOY_MODE: input.authMode === "local" ? "docker" : "desktop",
      OPENSHIP_TARGET: "local",
      OPENSHIP_LOCAL_DASHBOARD_URL: input.dashboardOrigin ?? `http://127.0.0.1:${input.port}`,
      OPENSHIP_EXTRA_TRUSTED_ORIGINS: [
        input.dashboardOrigin,
        input.publicUrl,
        `http://127.0.0.1:${input.port}`,
      ]
        .filter(Boolean)
        .join(","),
      OPENSHIP_AUTH_MODE: input.authMode ?? "none",
      OPENSHIP_API_ONLY: String(input.apiOnly ?? false),
      ...(input.authMode === "local"
        ? { OPENSHIP_PUBLIC_URL: input.publicUrl ?? `http://127.0.0.1:${input.port}` }
        : {}),
      OPENSHIP_API_ROOT: resolve(REPO_ROOT, "apps/api"),
      OPENSHIP_DATA_DIR: resolve(input.dbDir, "instance-data"),
      OPENSHIP_HOST_CONTROL: "false",
      CLOUD_MODE: String(input.cloudMode ?? false),
      DATABASE_URL: "",
      POSTGRES_HOST: "",
      POSTGRES_PASSWORD: "",
      PGHOST: "",
      PGPASSWORD: "",
      PGLITE_DATA_DIR: input.dbDir,
      BETTER_AUTH_SECRET: input.secret,
      INTERNAL_TOKEN: "instance-handoff-e2e-internal-token-000000000000",
      PORT: String(input.port),
      OPENSHIP_API_HOST: "127.0.0.1",
      OPENSHIP_ADVERTISED_ORIGIN: `http://127.0.0.1:${input.port}`,
      OPENSHIP_JOB_RUNNER: "in-process",
      OPENSHIP_CACHE_STORE: "memory",
      OPENSHIP_RATE_LIMIT_STORE: "memory",
      REDIS_URL: "redis://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-50_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const api: RunningApi = {
    child,
    baseUrl: `http://127.0.0.1:${input.port}`,
    dbDir: input.dbDir,
    port: input.port,
    secret: input.secret,
    logs: () => output,
  };
  try {
    await waitForApi(api);
  } catch (error) {
    await stopApi(api);
    throw error;
  }
  return api;
}

export async function stopApi(api: RunningApi): Promise<void> {
  if (api.child.exitCode === null) {
    api.child.kill("SIGTERM");
    const exited = new Promise<boolean>((resolve) => api.child.once("exit", () => resolve(true)));
    if (!(await Promise.race([exited, delay(15_000).then(() => false)]))) {
      api.child.kill("SIGKILL");
      await new Promise<void>((resolve) => api.child.once("exit", () => resolve()));
    }
  }
}

export async function jsonRequest<T>(
  apiBase: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

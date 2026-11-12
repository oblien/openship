import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export const project = {
  id: "environment-preview",
  name: "website",
  slug: "website",
  description: "",
  framework: "nextjs",
  activeDeploymentId: "live-preview",
  latestDeploymentId: "live-preview",
  status: "ready",
  runtimeMode: "bare",
  deployTarget: "server",
  serverId: "preview-server",
  port: 3000,
  gitOwner: "example",
  gitRepo: "website",
  gitBranch: "main",
  rootDirectory: ".",
  packageManager: "bun",
  buildCommand: "bun run build",
  startCommand: "bun run start",
  domains: [
    {
      id: "domain",
      domain: "website.example.com",
      hostname: "website.example.com",
      primary: true,
      verified: true,
    },
  ],
  domain: "website.example.com",
  publicUrl: "https://website.example.com",
  options: {
    workloadType: "web",
    hasServer: true,
    hasBuild: true,
    installCommand: "bun install",
    buildCommand: "bun run build",
    startCommand: "bun run start",
    productionPort: 3000,
    rootDirectory: ".",
  },
};
const base = {
  image: null,
  build: null,
  dockerfile: null,
  buildArgs: null,
  ports: [],
  dependsOn: [],
  environment: {},
  volumes: [],
  command: null,
  restart: "unless-stopped",
  exposed: false,
  exposedPort: null,
  domain: null,
  customDomain: null,
  domainType: "free",
  enabled: true,
  sortOrder: 0,
};
const primary = {
  ...base,
  id: "materialized-primary",
  name: "website",
  kind: "monorepo",
  applicationMode: "project",
  sortOrder: -1,
  exposed: true,
  exposedPort: "3000",
  domain: "website.example.com",
  rootDirectory: ".",
};
export const postgres = {
  ...base,
  id: "postgres",
  name: "postgres",
  kind: "compose",
  image: "postgres:17-alpine",
  ports: ["5432"],
  environment: { POSTGRES_DB: "website", POSTGRES_USER: "website", POSTGRES_PASSWORD: "••••••••" },
  volumes: ["postgres-data:/var/lib/postgresql/data"],
};
let services = [],
  started = new Set(),
  writes = [],
  pending = false;
let env = [
  {
    id: "site",
    key: "SITE_URL",
    value: "https://website.example.com",
    environment: "production",
    isSecret: false,
  },
  { id: "log", key: "LOG_LEVEL", value: "info", environment: "production", isSecret: false },
  { id: "secret", key: "API_SECRET", value: "••••••••", environment: "production", isSecret: true },
];
let serviceEnv = Object.entries(postgres.environment).map(([key, value]) => ({
  key,
  value,
  isSecret: key.includes("PASSWORD"),
  source: "compose",
}));
function merge(rows, input) {
  const deletes = input.deletes.map((row) => (typeof row === "string" ? row : row.key));
  const kept = rows.filter(
    (row) => !deletes.includes(row.key) && !input.upserts.some((up) => up.key === row.key),
  );
  return [
    ...kept,
    ...input.upserts.map((row) => ({
      ...row,
      id: row.key,
      sourceId: row.key,
      source: "service",
      environment: "production",
    })),
  ];
}
export const requests = [];
const initialEnv = structuredClone(env),
  initialServiceEnv = structuredClone(serviceEnv);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3013"),
    path = url.pathname,
    method = req.method;
  if (
    path === "/review" ||
    path === "/review/" ||
    /^\/review\/[a-z0-9-]+\.(png|html|json)$/.test(path)
  ) {
    const file = path === "/review" || path === "/review/" ? "index.html" : path.split("/").pop();
    try {
      const data = await readFile(resolve("artifacts/project-consistency", file));
      res.writeHead(200, {
        "Content-Type": file.endsWith("png")
          ? "image/png"
          : file.endsWith("json")
            ? "application/json"
            : "text/html",
      });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end("Not found");
    }
  }
  requests.push({ path, method });
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "http://localhost:3012");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "content-type",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  let input = null;
  for await (const part of req) input = (input || "") + part;
  if (input) {
    try {
      input = JSON.parse(input);
    } catch {}
  }
  let body = { success: true, data: [] },
    status = 200;
  if (path === "/api/preview/scenario") {
    if (method === "POST") {
      if (input.reset) {
        env = structuredClone(initialEnv);
        serviceEnv = structuredClone(initialServiceEnv);
        writes = [];
        pending = false;
      }
      services = input.services ? [primary, structuredClone(postgres)] : [];
      started = new Set(input.services ? ["postgres"] : []);
      project.runtimeMode = input.kind === "docker" ? "docker" : "bare";
      project.options.workloadType = input.kind === "static" ? "static" : "web";
      project.options.hasServer = input.kind !== "static";
      project.deployTarget = input.kind === "cloud" ? "cloud" : "server";
      if (input.kind === "static")
        services = services.filter((s) => s.id !== "materialized-primary");
    }
    body = { project, services, writes };
  } else if (path.endsWith("/get-session")) body = null;
  else if (path.endsWith("/health/env"))
    body = { selfHosted: true, deployMode: "server", authMode: "none", isServerHost: true };
  else if (path.endsWith("/health")) body = { status: "ok" };
  else if (path.endsWith("/info")) body = { success: true, data: { project, environments: [] } };
  else if (path.endsWith("/services/containers"))
    body = {
      success: true,
      containers: services.map((s) => ({
        serviceId: s.id,
        serviceName: s.name,
        containerId: started.has(s.id) ? `${s.id}-container` : null,
        status: started.has(s.id) ? "running" : "stopped",
        ip: "172.18.0.3",
        hostPort: null,
        imageRef: s.image,
      })),
    };
  else if (path.endsWith("/services") && method === "GET") body = { success: true, services };
  else if (path.endsWith("/services") && method === "POST") {
    const service = {
      ...base,
      ...input,
      id: input.name || "postgres",
      kind: input.kind || "compose",
    };
    services = [primary, ...services.filter((s) => s.id !== primary.id), service];
    body = { success: true, service };
    writes.push({ path, input });
  } else if (path.includes("/services/") && /\/(start|restart|apply-environment)$/.test(path)) {
    const sid = path.split("/services/")[1].split("/")[0];
    started.add(sid);
    pending = false;
    body = { success: true, containerId: `${sid}-container` };
    writes.push({ path, input });
  } else if (path.includes("/services/") && path.endsWith("/environment"))
    body = {
      success: true,
      environment: {
        environment: "production",
        variables: serviceEnv,
        missingRequired: [],
        status:
          url.searchParams.get("inspectRuntime") === "true"
            ? pending
              ? "pending"
              : "synced"
            : "unchecked",
        changedKeys: pending ? ["POSTGRES_DB"] : [],
        recoverableKeys: [],
        containerId: "postgres-container",
      },
    };
  else if (path.includes("/services/") && path.endsWith("/env") && method === "PATCH") {
    serviceEnv = merge(serviceEnv, input);
    pending = true;
    writes.push({ path, input });
  } else if (path.endsWith("/env") && method === "GET") body = { data: env };
  else if (path.endsWith("/env") && method === "PATCH") {
    env = merge(env, input);
    body = { upserted: input.upserts.length, deleted: input.deletes.length };
    writes.push({ path, input });
  } else if (path.endsWith("/env/reveal"))
    body = {
      success: true,
      environment: Object.fromEntries(input.keys.map((key) => [key, "sample-preview-secret"])),
    };
  else if (path === "/api/deployments" && method === "POST") {
    body = { success: true, data: { deployment: { id: "preview-apply" } } };
    writes.push({ path, input });
  } else if (path.endsWith("/roles"))
    body = { data: { deploymentId: "live-preview", supported: false, roles: [], error: null } };
  else if (path.includes("/runtime-update"))
    body = { data: { supported: false, canUpdate: false } };
  else if (path.endsWith("/build-cache/migration"))
    body = { data: { candidates: [], canMigrate: false } };
  else if (path.endsWith("/resources"))
    body = {
      data: {
        tier: "medium",
        production: { cpuCores: 1, memoryMb: 1024, diskMb: 16384 },
        build: { cpuCores: 2, memoryMb: 2048, diskMb: 32768 },
        sleepMode: "off",
        port: 3000,
        requiresLimit: false,
      },
    };
  else if (path.endsWith("/storage"))
    body = {
      data: {
        binding: null,
        volumes: [],
        resolvedVolumes: [],
        envPreset: "",
        envKeys: [],
        candidates: [],
        providers: {},
      },
    };
  else if (path.endsWith("/connections")) body = { data: [] };
  else if (path.endsWith("/domains")) body = { data: [] };
  else if (path.endsWith("/updates/status")) body = { data: { supported: false } };
  else if (path.endsWith("/volume-sizes"))
    body = { success: true, measurable: false, volumes: [], totalBytes: null, partial: false };
  else if (path.includes("/logs") && path.includes("stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"message":"Preview runtime ready on port 3000"}\n\n');
    return res.end();
  } else if (path.includes("/services/") && method === "GET")
    body = {
      success: true,
      service: services.find((s) => s.id === path.split("/services/")[1].split("/")[0]) || postgres,
    };
  else if (!["GET", "HEAD"].includes(method)) {
    status = 422;
    body = { error: "This operation is outside the preview fixture." };
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});
server.listen(Number(process.env.PREVIEW_API_PORT || 3013), "127.0.0.1", () =>
  console.log("Fixture API: http://localhost:3013 (sample data only)"),
);

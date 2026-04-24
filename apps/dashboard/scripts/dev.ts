import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CLOUD_API_URL,
  CLOUD_DASHBOARD_URL,
  LOCAL_DASHBOARD_PORT,
  LOCAL_API_URL,
  LOCAL_SAAS_DASHBOARD_PORT,
  LOCAL_SAAS_API_URL,
} from "@repo/onboarding";

type Mode = "local" | "saas";
type SaasTarget = "public" | "local";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next");

function parseMode(value: string | undefined): Mode {
  return value === "saas" ? "saas" : "local";
}

function parseSaasTarget(value: string | undefined): SaasTarget {
  return value === "local" ? "local" : "public";
}

function getSaasApiUrl(target: SaasTarget) {
  return target === "local" ? LOCAL_SAAS_API_URL : CLOUD_API_URL;
}

function getCloudDashboardUrl() {
  return process.env.NEXT_PUBLIC_CLOUD_DASHBOARD_URL
    ?? process.env.OPENSHIP_CLOUD_DASHBOARD_URL
    ?? CLOUD_DASHBOARD_URL;
}

function getCloudApiUrl() {
  return process.env.NEXT_PUBLIC_CLOUD_API_URL
    ?? process.env.OPENSHIP_CLOUD_URL
    ?? CLOUD_API_URL;
}

function getConfig(mode: Mode, saasTarget: SaasTarget) {
  if (mode === "saas") {
    return {
      port: String(LOCAL_SAAS_DASHBOARD_PORT),
      distDir: ".next-saas",
      apiUrl: process.env.NEXT_PUBLIC_API_URL
        ?? process.env.OPENSHIP_SAAS_API_URL
        ?? getSaasApiUrl(saasTarget),
      cloudApiUrl: getCloudApiUrl(),
      cloudDashboardUrl: getCloudDashboardUrl(),
    };
  }

  return {
    port: String(LOCAL_DASHBOARD_PORT),
    distDir: ".next",
    apiUrl: process.env.NEXT_PUBLIC_API_URL
      ?? process.env.OPENSHIP_LOCAL_API_URL
      ?? LOCAL_API_URL,
    cloudApiUrl: getCloudApiUrl(),
    cloudDashboardUrl: getCloudDashboardUrl(),
  };
}

const mode = parseMode(process.argv[2]);
const saasTarget = parseSaasTarget(process.argv[3] ?? process.env.OPENSHIP_SAAS_TARGET);
const config = getConfig(mode, saasTarget);

const child = spawn("node", [nextBin, "dev", "--port", config.port], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_API_URL: config.apiUrl,
    NEXT_PUBLIC_CLOUD_API_URL: config.cloudApiUrl,
    NEXT_PUBLIC_CLOUD_DASHBOARD_URL: config.cloudDashboardUrl,
    OPENSHIP_CLOUD_URL: process.env.OPENSHIP_CLOUD_URL ?? config.cloudApiUrl,
    OPENSHIP_CLOUD_DASHBOARD_URL: process.env.OPENSHIP_CLOUD_DASHBOARD_URL ?? config.cloudDashboardUrl,
    NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? config.distDir,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

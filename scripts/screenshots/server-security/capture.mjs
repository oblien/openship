import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, "../../..");
const origin = process.env.SCREENSHOT_ORIGIN ?? "http://localhost:3001";
const dir = resolve(root, "apps/dashboard/src/app/server-security-capture");
const out = process.env.SCREENSHOT_OUTPUT ?? resolve(root, "docs/screenshots/server-security");
const require = createRequire(import.meta.url);
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve("playwright")).href
);
const finding = {
  id: "HOST-PREVIEW",
  revision: 1,
  title: "Ubuntu package update",
  message: "Synthetic advisory: review the available package update on this server.",
  severity: "high",
  url: "https://ubuntu.com/security",
  packages: ["openssl"],
  evidence: ["openssl: 3.0.13-0ubuntu3.9"],
  state: "affected",
  canPatch: true,
  canReboot: false,
};
let status = {
  serverId: "preview-host",
  name: "Commerce host",
  checksEnabled: true,
  supported: true,
  canManage: true,
  pending: false,
  checkedAt: "2026-11-03T09:00:00Z",
  nextCheckAt: "2026-11-03T15:00:00Z",
  error: null,
  feedStale: false,
  findings: [finding],
};
let history = [],
  operation = "install",
  browser,
  ownsDir = false;
const writes = [],
  streams = [],
  errors = [];
try {
  await mkdir(dir);
  ownsDir = true;
  await writeFile(resolve(dir, "Preview.tsx"), await readFile(resolve(here, "Preview.tsx")), {
    flag: "wx",
  });
  await writeFile(
    resolve(dir, "page.tsx"),
    'import { notFound } from "next/navigation"; import Preview from "./Preview"; export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <Preview />; }',
    { flag: "wx" },
  );
  await mkdir(out, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  await context.addCookies([
    { name: "capture.session_token", value: "visual-fixture-only", url: origin },
  ]);
  await context.addInitScript(() => localStorage.setItem("theme", "dim"));
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.includes("/api/") || url.pathname.startsWith("/health")) {
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers":
          request.headers()["access-control-request-headers"] ?? "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      let body = null;
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        writes.push({ path: url.pathname, body: request.postDataJSON() });
        if (url.pathname.endsWith("/security/plan")) {
          operation = request.postDataJSON().operation;
          body = {
            data: {
              operation,
              token: "synthetic-reviewed-token",
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              advisoryId: finding.id,
              title: finding.title,
              changes:
                operation === "reboot"
                  ? []
                  : [
                      {
                        package: "libssl3t64",
                        previous: "3.0.13-0ubuntu3.9",
                        version: "3.0.13-0ubuntu3.16",
                      },
                      {
                        package: "openssl",
                        previous: "3.0.13-0ubuntu3.9",
                        version: "3.0.13-0ubuntu3.16",
                      },
                    ],
              rebootRequired: operation === "reboot",
            },
          };
        } else if (url.pathname.endsWith("/security/apply")) {
          assert.equal(request.postDataJSON().token, "synthetic-reviewed-token");
          history = [
            {
              id: "preview-run",
              jobId: "security:patch:preview-host",
              startedAt: "2026-11-03T09:10:00Z",
              status: "running",
              summary: {
                advisoryId: finding.id,
                phase: "installing",
                steps: [
                  { id: "prepare", label: "Check server and approval", status: "completed" },
                  { id: "apply", label: "Install reviewed packages", status: "running" },
                  {
                    id: "verify",
                    label: "Verify packages and server components",
                    status: "pending",
                  },
                ],
              },
              output:
                "Installing reviewed packages…\nInstalled OpenSSL and its reviewed dependency.\nInstalled package versions verified.\n",
              error: null,
            },
          ];
          status = { ...status, findings: [] };
          body = { data: { runId: "preview-run" } };
        } else throw new Error(`Unexpected fixture write: ${url.pathname}`);
      } else if (url.pathname.endsWith("/security/runs/preview-run/stream")) {
        streams.push({ path: url.pathname, method: request.method() });
        const before = history[0];
        history = [{ ...before, status: "success", summary: { ...before.summary,
          phase: "verified", logSeq: 1,
          steps: before.summary.steps.map(step => ({ ...step, status: "completed" })),
        } }];
        const events = [
          { type: "snapshot", run: before },
          { type: "log", seq: 1, line: "Installed package versions verified.", level: "info" },
          { type: "snapshot", run: history[0] },
          { type: "complete", status: "success" },
        ];
        return route.fulfill({ status: 200, contentType: "text/event-stream", headers,
          body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        });
      } else if (url.pathname.endsWith("/security/runs")) body = { data: history };
      else if (url.pathname.endsWith("/security")) body = { data: status };
      else if (url.pathname.endsWith("/health/env"))
        body = { selfHosted: true, deployMode: "docker", authMode: "local", version: "0.9.8" };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });
    }
    if (url.origin === origin || ["cdn.oblien.com", "cdn.simpleicons.org"].includes(url.hostname))
      return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => errors.push(e.message));
  const visit = async (query = "") => {
    await page.goto(`${origin}/server-security-capture${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
  };
  const shot = (name) =>
    page.screenshot({ path: resolve(out, name), fullPage: true, animations: "disabled" });
  await visit();
  await page.getByRole("button", { name: "Review patch", exact: true }).waitFor();
  assert.equal(writes.length, 0);
  await page.getByRole("button", { name: "Review patch", exact: true }).click();
  await page.getByRole("button", { name: "Apply reviewed patch", exact: true }).waitFor();
  assert.equal(writes.length, 1);
  await shot("review-patch.png");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot("review-patch-mobile.png");
  await page.getByRole("button", { name: "Apply reviewed patch", exact: true }).click();
  await page.getByText("Verify packages and server components", { exact: true }).waitFor();
  await page.getByText("Version check passed", { exact: true }).waitFor();
  await page.locator(".xterm-screen").waitFor();
  assert.ok(streams.length > 0);
  assert.ok(streams.every(stream => stream.method === "GET"));
  await page.waitForTimeout(500);
  assert.equal(writes.length, 2);
  assert.ok(page.url().includes("server-security-capture"));
  await shot("verified-run-mobile.png");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(300);
  await shot("verified-run.png");
  status = {
    ...status,
    findings: [
      {
        ...finding,
        title: "Ubuntu kernel update",
        state: "reboot_required",
        canPatch: false,
        canReboot: true,
      },
    ],
  };
  await visit();
  await page.getByRole("button", { name: "Review reboot", exact: true }).click();
  await page.getByRole("button", { name: "Schedule reboot", exact: true }).waitFor();
  assert.equal(writes.length, 3);
  await shot("review-reboot.png");
  await visit("?monitoring=1");
  await page.getByText("Advisory inspection task", { exact: true }).waitFor();
  await shot("monitoring-task.png");
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(out, "browser-checks.json"),
    JSON.stringify(
      {
        source: "synthetic intercepted API; actual dashboard components",
        writes,
        streams,
        pageErrors: errors,
        checks: [
          "read-only page load",
          "review before apply",
          "exact dependency versions",
          "mobile overflow",
          "server run output",
          "shared live stream completes without another apply",
          "separate reboot review",
          "visible monitoring task",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  if (ownsDir) await rm(dir, { recursive: true, force: true });
}

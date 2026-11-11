import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { buildCatalog } from "../packages/core/scripts/gen-catalog";
import type { AppTemplate, TemplateServiceSpec } from "../packages/core/src/app-templates";
import { runAppPrepareCommand } from "../packages/platform/src/engine/modules/deployments/compose/app-prepare";
import retiredBuilds from "./fixtures/catalog-retired-builds.json";
import { appGpuEnvironment } from "../packages/core/src/apps/gpu";

export const OFFICIAL_APP_STACKS = [
  "wordpress",
  "odoo",
  "postgresql",
  "mariadb",
  "rabbitmq",
  "authentik",
  "nextcloud",
  "paperless-ngx",
  "wiki-js",
  "homepage",
  "immich",
  "jellyfin",
  "ollama",
  "open-webui",
  "appwrite",
  "prometheus",
  "loki",
  "alertmanager",
  "victoriametrics",
  "beszel",
  "pgadmin4",
  "listmonk",
  "otel-collector",
] as const;
const run = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function inputValue(html: string, name: string): string | undefined {
  const input = html
    .match(/<input\b[^>]*>/gi)
    ?.find((tag) => new RegExp("\\bname=['\"]" + name + "['\"]").test(tag));
  return input && /\bvalue=['"]([^'"]*)/.exec(input)?.[1];
}
let operation = "initialization";
const docker = async (...args: string[]) => {
  try {
    const result = await run("docker", args, { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
  } catch (error) {
    // Docker errors embed argv, which can contain the disposable test credentials.
    const stderr =
      (error as { stderr?: string }).stderr?.replace(/[a-f0-9]{64}/g, "[redacted]") ?? "";
    const failurePath = join(
      tmpdir(),
      "openship-catalog-smoke-" + operation.split("/")[0] + "-docker-failure.log",
    );
    if (stderr && !operation.endsWith("/cleanup"))
      await writeFile(failurePath, stderr, {
        mode: 0o600,
      });
    throw new Error(
      `Docker ${args[0]} ${(error as { killed?: boolean }).killed ? "timed out" : "failed"} during ${operation}; details: ${failurePath}`,
    );
  }
};

/** Disposable local integration stack. All runtime image/argv/env/volume/config
 * comes from the canonical template. App-specific checks exercise real login
 * and data APIs; no production API, Cloud purchase, or customer data is used. */
async function smokeApp(app: AppTemplate) {
  const testRetired = process.env.CATALOG_TEST_FROM_RETIRED_BUILD === "1";
  if (testRetired && app.id !== "wordpress" && app.id !== "odoo")
    throw new Error("Retired-build conversion tests support only WordPress and Odoo");
  const retired = testRetired ? retiredBuilds[app.id as keyof typeof retiredBuilds] : undefined;
  // Start with the actual historical recipe, then replace only the application
  // with today's official image and mounted helper on the same data volumes.
  let runtimeRecipe = retired
    ? {
        ...app,
        services: app.services!.map((s) => {
          if (s.name !== app.id) return s;
          const { image, commandArgv, ...rest } = s;
          return { ...rest, build: retired };
        }),
        files: (app.files ?? []).filter((f) => f.service !== app.id),
      }
    : app;
  const prefix = "openship-app-smoke-" + randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const names = new Map(app.services!.map((s) => [s.name, prefix + "-" + s.name]));
  const volumes = new Map<string, string>();
  const configVolumes = new Map<string, string>();
  const images = new Map<string, string>();
  const generatedImages = new Set<string>();
  const environment = new Map<string, Record<string, string>>();
  const urls = new Map<string, string>();
  const config = new Map<string, string>();
  const groups = new Map<string, string>();
  const marker = randomUUID();
  // Keep ports per invocation local to this disposable test. Independent CI
  // jobs run on independent hosts; no database/broker port is published.
  let port = 35_000 + Math.floor(Math.random() * 15_000);
  for (const s of app.services!) if (s.exposedPort) urls.set(s.name, "http://127.0.0.1:" + port++);
  for (const field of app.configFields ?? []) {
    let value = field.default ?? "";
    if (field.generate === "secret") {
      value =
        (field.generateGroup && groups.get(field.generateGroup)) || randomBytes(32).toString("hex");
      if (field.generateGroup) groups.set(field.generateGroup, value);
    }
    config.set(field.key, value);
  }
  for (const group of app.settings ?? [])
    for (const field of group.fields) {
      config.set(
        field.key,
        field.key.includes("EMAIL") ? "smoke@openship.io" : (field.default ?? ""),
      );
    }
  const resolve = (value: string) =>
    value
      .replace(/\{\{config:([^}]+)\}\}/g, (_, key) => config.get(key) ?? "")
      .replace(
        /\{\{publicUrl:([^}:]+)(?::\d+)?\}\}/g,
        (_, name) => urls.get(name) ?? "http://" + name,
      );
  const exec = (service: string, command: string) =>
    docker("exec", names.get(service)!, "sh", "-c", command);
  const env = (service: string, key: string) => environment.get(service)![key]!;
  const url = (service: string, path = "") => urls.get(service)! + path;
  const basic = (user: string, password: string) =>
    "Basic " + Buffer.from(user + ":" + password).toString("base64");
  const request = async (service: string, path: string, options?: RequestInit) =>
    fetch(url(service, path), { ...options, signal: AbortSignal.timeout(30_000) });
  const waitHealthy = async (service: TemplateServiceSpec) => {
    const deadline = Date.now() + 480_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(
        await docker("inspect", "--format", "{{json .State}}", names.get(service.name)!),
      );
      const health = service.healthcheck as { test: string[] } | undefined;
      if (state.Running && health?.test[0] === "CMD") {
        // Docker CLI --health-cmd always invokes /bin/sh. Distroless images need
        // their exact exec-form probe, as used by the deployment adapter.
        try {
          await run("docker", ["exec", names.get(service.name)!, ...health.test.slice(1)], {
            timeout: 10_000,
          });
          return;
        } catch {
          // The service is still starting; retry within the bounded deadline.
        }
      } else if (state.Health?.Status === "healthy" || (!health && state.Running)) return;
      if (state.OOMKilled || (!state.Running && !state.Restarting))
        throw new Error(app.id + "/" + service.name + " exited during startup");
      await pause(2_000);
    }
    // Persist local, bounded logs without echoing credential-bearing argv.
    const log = await docker("logs", "--tail", "100", names.get(service.name)!).catch(
      () => "unavailable",
    );
    const sanitized = [...config.values()]
      .filter((v) => v.length >= 24)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), log);
    await writeFile(join(dir, "failure.log"), sanitized, { mode: 0o600 });
    throw new Error(app.id + "/" + service.name + " did not become healthy");
  };
  const create = async (s: TemplateServiceSpec) => {
    const memory = s.resources ? s.resources.memoryMb + "m" : app.category === "ai" ? "1536m" : "768m";
    const args = [
      "create",
      "--name",
      names.get(s.name)!,
      "--hostname",
      s.name,
      "--network",
      prefix,
      "--network-alias",
      s.name,
      "--label",
      "openship.test=catalog-apps",
      "--memory",
      memory,
    ];
    if (s.shmSize) args.push("--shm-size", String(s.shmSize));
    if (s.entrypointArgv) args.push("--entrypoint", s.entrypointArgv[0] ?? "");
    if (s.resources) args.push("--cpus", String(s.resources.cpuCores));
    if (s.exposedPort)
      args.push("-p", "127.0.0.1:" + new URL(urls.get(s.name)!).port + ":" + s.exposedPort);
    for (const [key, value] of Object.entries(environment.get(s.name)!))
      args.push("-e", key + "=" + value);
    for (const mount of s.volumes ?? []) {
      const [name, target, mode] = mount.split(":");
      assert(name && target, "Malformed catalog mount");
      args.push("-v", volumes.get(name)! + ":" + target + (mode ? ":" + mode : ""));
    }
    const health = s.healthcheck as
      | {
          test: string[];
          interval?: string;
          timeout?: string;
          retries?: number;
          startPeriod?: string;
        }
      | undefined;
    if (health?.test[0] === "CMD-SHELL") {
      args.push(
        "--health-cmd",
        health.test[0] === "CMD-SHELL"
          ? health.test[1]!
          : health.test.slice(1).map(quote).join(" "),
      );
      for (const [flag, value] of [
        ["--health-interval", health.interval],
        ["--health-timeout", health.timeout],
        ["--health-retries", health.retries?.toString()],
        ["--health-start-period", health.startPeriod],
      ] as const)
        if (value) args.push(flag, value);
    }
    const files = (runtimeRecipe.files ?? []).filter((f) => f.service === s.name);
    if (files.length) {
      const fileRoot = join(dir, "config", s.name);
      const volume = configVolumes.get(s.name) ?? prefix + "-" + s.name + "-config";
      if (!configVolumes.has(s.name)) {
        await docker("volume", "create", "--label", "openship.test=catalog-apps", volume);
        configVolumes.set(s.name, volume);
      }
      const helper = prefix + "-" + s.name + "-config-writer";
      try {
        await docker(
          "create",
          "--name",
          helper,
          "--label",
          "openship.test=catalog-apps",
          "--network",
          "none",
          "--entrypoint",
          "sh",
          "--mount",
          "type=volume,source=" + volume + ",target=/config",
          images.get(s.name)!,
        );
        for (const [index, file] of files.entries()) {
          assert(
            file.path.startsWith("/") && !file.path.split("/").includes(".."),
            "Unsafe catalog file path",
          );
          const path = join(fileRoot, String(index));
          await mkdir(fileRoot, { recursive: true });
          await writeFile(path, resolve(file.content), { mode: 0o644 });
          await chmod(path, 0o644);
          await docker("cp", path, helper + ":/config/" + index);
        }
      } finally {
        await docker("rm", "-f", "-v", helper).catch(() => {});
      }
      // Mirror the engine's individual read-only file binds. Staging in a
      // daemon volume works with local Linux, Colima, and remote test daemons.
      const source = await docker("volume", "inspect", "--format", "{{.Mountpoint}}", volume);
      for (const [index, file] of files.entries())
        args.push(
          "--mount",
          "type=bind,source=" + source + "/" + index + ",target=" + file.path + ",readonly",
        );
    }
    args.push(images.get(s.name)!);
    if (s.entrypointArgv) args.push(...s.entrypointArgv.slice(1));
    if (s.commandArgv) args.push(...s.commandArgv);
    else if (s.command) args.push("sh", "-c", s.command);
    await docker(...args);
  };
  const start = async () => {
    for (const s of runtimeRecipe.services!) {
      operation = app.id + "/start/" + s.name;
      await create(s);
      await docker("start", names.get(s.name)!);
      await waitHealthy(s);
    }
    for (const step of app.prepare ?? []) {
      operation = app.id + "/prepare/" + step.capture;
      await runAppPrepareCommand(step, { exec: (command) => exec(step.service, command) });
    }
  };
  const replace = async () => {
    if (runtimeRecipe !== app) {
      const applications = app.services!.filter((s) => s.name === app.id);
      for (const s of applications) {
        await docker("pull", s.image!);
        images.set(s.name, s.image!);
        await docker("rm", "-f", names.get(s.name)!);
      }
      runtimeRecipe = app;
      for (const s of applications) {
        await create(s);
        await docker("start", names.get(s.name)!);
        await waitHealthy(s);
      }
      return;
    }
    for (const s of [...app.services!].reverse()) {
      if (
        [
          "paperless-ngx",
          "wiki-js",
          "homepage",
          "immich",
          "jellyfin",
          "prometheus",
          "loki",
          "alertmanager",
          "victoriametrics",
          "beszel",
          "pgadmin4",
          "listmonk",
        ].includes(app.id) ||
        (app.id === "appwrite" &&
          ["redis", "postgresql", "appwrite-mongodb", "clickhouse"].includes(s.name))
      ) {
        await docker("stop", "--time", "60", names.get(s.name)!);
        const state = JSON.parse(
          await docker("inspect", "--format", "{{json .State}}", names.get(s.name)!),
        );
        assert(
          state.ExitCode !== 137 && !state.OOMKilled,
          app.id + "/" + s.name + " did not stop gracefully",
        );
      }
      await docker("rm", "-f", names.get(s.name)!);
    }
    await start();
  };
  try {
    operation = app.id + "/provision";
    await docker("network", "create", "--label", "openship.test=catalog-apps", prefix);
    for (const s of runtimeRecipe.services!) {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(s.environment ?? {})) values[key] = resolve(value);
      for (const f of app.configFields ?? [])
        if (f.service === s.name && config.get(f.key)) values[f.key] = config.get(f.key)!;
      for (const group of app.settings ?? [])
        for (const f of group.fields) if (f.service === s.name) values[f.key] = config.get(f.key)!;
      environment.set(s.name, appGpuEnvironment({ ...s, environment: values }, false));
      for (const mount of s.volumes ?? []) {
        const name = mount.split(":")[0]!;
        if (!volumes.has(name)) {
          volumes.set(name, prefix + "-" + name);
          await docker(
            "volume",
            "create",
            "--label",
            "openship.test=catalog-apps",
            volumes.get(name)!,
          );
        }
      }
      if (s.build) {
        const context = join(dir, "build", s.name);
        await mkdir(context, { recursive: true });
        await writeFile(join(context, "Dockerfile"), resolve(s.build.dockerfile));
        for (const file of s.build.files ?? []) {
          const path = join(context, s.name, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, resolve(file.content));
        }
        const image = prefix + "/" + s.name + ":test";
        await docker("build", "--label", "openship.test=catalog-apps", "-t", image, context);
        generatedImages.add(image);
        images.set(s.name, image);
      } else {
        images.set(s.name, s.image!);
        await docker("pull", s.image!);
      }
    }
    await start();
    operation = app.id + "/login-and-write";
    switch (app.id) {
      case "prometheus":
      case "loki":
      case "alertmanager": {
        const access = app.id + "-access";
        assert(
          (await request(access, "/")).status === 401,
          "Monitoring endpoint is public without authentication",
        );
        const headers = {
          Authorization: basic(
            env(access, "OPENSHIP_ADMIN_USER"),
            env(access, "OPENSHIP_ADMIN_PASSWORD"),
          ),
          "Content-Type": "application/json",
        };
        const wrong = { Authorization: basic("admin", "incorrect") };
        assert(
          (await request(access, "/", { headers: wrong })).status === 401,
          "Monitoring endpoint accepted an incorrect password",
        );
        const now = Date.now();
        let checkPath: string;
        if (app.id === "prometheus") {
          checkPath = "/api/v1/query?query=prometheus_build_info";
          let found = false;
          for (let i = 0; i < 30; i++) {
            const data = (await (await request(access, checkPath, { headers })).json()) as any;
            if (data.data?.result?.length) {
              found = true;
              break;
            }
            await pause(2_000);
          }
          assert(found, "Prometheus did not scrape its default target");
          // Query the same historical sample after replacing the TSDB container.
          checkPath += "&time=" + Date.now() / 1000;
        } else if (app.id === "loki") {
          const response = await request(access, "/loki/api/v1/push", {
            method: "POST",
            headers,
            body: JSON.stringify({
              streams: [
                { stream: { job: marker }, values: [[String(BigInt(now) * 1_000_000n), marker]] },
              ],
            }),
          });
          assert(response.status === 204, "Loki rejected an authenticated log write");
          checkPath =
            "/loki/api/v1/query_range?query=" +
            encodeURIComponent('{job="' + marker + '"}') +
            "&start=" +
            (now - 1000) * 1e6 +
            "&end=" +
            (now + 1000) * 1e6;
        } else {
          const response = await request(access, "/api/v2/silences", {
            method: "POST",
            headers,
            body: JSON.stringify({
              matchers: [{ name: "alertname", value: marker, isRegex: false, isEqual: true }],
              startsAt: new Date(now).toISOString(),
              endsAt: new Date(now + 3600_000).toISOString(),
              createdBy: "catalog-smoke",
              comment: marker,
            }),
          });
          assert(response.ok, "Alertmanager rejected an authenticated silence");
          const silence = (await response.json()) as any;
          checkPath = "/api/v2/silence/" + silence.silenceID;
        }
        const before = await request(access, checkPath, { headers });
        const body = await before.text();
        assert(
          before.ok &&
            (app.id === "prometheus"
              ? body.includes("prometheus_build_info")
              : body.includes(marker)),
          "Monitoring data could not be read",
        );
        await replace();
        assert(
          (await request(access, "/")).status === 401,
          "Monitoring endpoint lost its authentication on redeploy",
        );
        const after = await request(access, checkPath, { headers });
        const saved = await after.text();
        assert(
          after.ok &&
            (app.id === "prometheus"
              ? saved.includes("prometheus_build_info")
              : saved.includes(marker)),
          "Monitoring data did not persist after replacement",
        );
        break;
      }
      case "victoriametrics": {
        const headers = {
          Authorization: basic("admin", env("victoriametrics", "httpAuth_password")),
        };
        assert(
          (await request("victoriametrics", "/api/v1/query?query=up")).status === 401,
          "VictoriaMetrics allowed unauthenticated queries",
        );
        const metric = 'openship_smoke{marker="' + marker + '"} 42\n';
        assert(
          (
            await request("victoriametrics", "/api/v1/import/prometheus", {
              method: "POST",
              headers,
              body: metric,
            })
          ).ok,
          "VictoriaMetrics rejected metric write",
        );
        const query =
          "/api/v1/query?query=" + encodeURIComponent('openship_smoke{marker="' + marker + '"}');
        // Flush pending insert buffers through the supported query flag.
        const read = () => request("victoriametrics", query + "&nocache=1", { headers });
        let found = false;
        for (let i = 0; i < 15; i++) {
          if ((await (await read()).text()).includes(marker)) {
            found = true;
            break;
          }
          await pause(1_000);
        }
        assert(found, "VictoriaMetrics did not return imported metric");
        await replace();
        assert(
          (await (await read()).text()).includes(marker),
          "VictoriaMetrics data did not persist",
        );
        break;
      }
      case "listmonk": {
        const login = async () => {
          const response = await request("listmonk", "/admin/login", {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              username: env("listmonk", "LISTMONK_ADMIN_USER"),
              password: env("listmonk", "LISTMONK_ADMIN_PASSWORD"),
              next: "/",
            }),
          });
          assert(
            response.status === 302 && response.headers.getSetCookie().length > 0,
            "Listmonk generated administrator could not sign in",
          );
          return {
            "Content-Type": "application/json",
            Cookie: response.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
          };
        };
        let headers = await login();
        const anonymous = await request("listmonk", "/api/subscribers", {
          redirect: "manual",
          headers: { Accept: "application/json" },
        });
        assert(
          anonymous.status === 401 ||
            anonymous.status === 403 ||
            (anonymous.status === 302 &&
              anonymous.headers.get("Location")?.includes("/admin/login")),
          "Listmonk allowed unauthenticated subscriber access (HTTP " + anonymous.status + ")",
        );
        const created = await request("listmonk", "/api/subscribers", {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: marker + "@example.com",
            name: marker,
            status: "enabled",
            lists: [],
          }),
        });
        assert(created.ok, "Listmonk administrator could not create a subscriber");
        const subscriber = ((await created.json()) as any).data;
        await replace();
        headers = await login();
        const response = await request("listmonk", "/api/subscribers/" + subscriber.id, {
          headers,
        });
        assert(
          response.ok && (await response.text()).includes(marker),
          "Listmonk login or subscriber did not persist",
        );
        break;
      }
      case "beszel": {
        const login = async () => {
          const response = await request("beszel", "/api/collections/users/auth-with-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              identity: env("beszel", "USER_EMAIL"),
              password: env("beszel", "USER_PASSWORD"),
            }),
          });
          assert(response.ok, "Beszel initial owner could not sign in");
          return (await response.json()) as any;
        };
        const user = await login();
        const headers = { "Content-Type": "application/json", Authorization: user.token };
        const list = (await (
          await request("beszel", "/api/collections/user_settings/records", { headers })
        ).json()) as any;
        const existing = list.items?.[0];
        const path = "/api/collections/user_settings/records" + (existing ? "/" + existing.id : "");
        const response = await request("beszel", path, {
          method: existing ? "PATCH" : "POST",
          headers,
          body: JSON.stringify({ user: user.record.id, settings: { chartTime: "24h" } }),
        });
        assert(response.ok, "Beszel owner could not save dashboard preferences");
        await replace();
        const savedUser = await login();
        const saved = await request("beszel", "/api/collections/user_settings/records", {
          headers: { Authorization: savedUser.token },
        });
        const savedSettings = (await saved.json()) as any;
        assert(
          saved.ok && savedSettings.items?.[0]?.settings?.chartTime === "24h",
          "Beszel dashboard preferences did not persist",
        );
        break;
      }
      case "pgadmin4": {
        const login = async () => {
          const page = await request("pgadmin4", "/login");
          const html = await page.text();
          const csrf =
            inputValue(html, "csrf_token") ?? /"csrfToken"\s*:\s*"([^"]+)"/.exec(html)?.[1];
          assert(csrf, "pgAdmin did not return a CSRF token");
          const response = await request("pgadmin4", "/login", {
            method: "POST",
            redirect: "manual",
            headers: {
              "Content-Type": "application/json",
              "X-CSRFToken": csrf,
              Cookie: page.headers
                .getSetCookie()
                .map((c) => c.split(";")[0])
                .join("; "),
            },
            body: JSON.stringify({
              email: env("pgadmin4", "PGADMIN_DEFAULT_EMAIL"),
              password: env("pgadmin4", "PGADMIN_DEFAULT_PASSWORD"),
            }),
          });
          const cookies = new Map(
            [...page.headers.getSetCookie(), ...response.headers.getSetCookie()].map((c) => {
              const pair = c.split(";")[0]!;
              return [pair.split("=")[0], pair] as const;
            }),
          );
          const browser = await request("pgadmin4", "/browser/", {
            redirect: "manual",
            headers: { Cookie: [...cookies.values()].join("; ") },
          });
          assert(
            browser.status === 200 && !browser.headers.get("Location"),
            "pgAdmin administrator login failed",
          );
        };
        await login();
        const servers = JSON.stringify({
          Servers: {
            "1": {
              Name: marker,
              Group: "Servers",
              Host: "database.example.com",
              Port: 5432,
              MaintenanceDB: "postgres",
              Username: "app",
              SSLMode: "prefer",
            },
          },
        });
        await exec(
          "pgadmin4",
          "printf %s " +
            quote(servers) +
            ' > /tmp/servers.json && /venv/bin/python3 /pgadmin4/setup.py load-servers /tmp/servers.json --user "$PGADMIN_DEFAULT_EMAIL"',
        );
        await replace();
        await login();
        const exported = await exec(
          "pgadmin4",
          '/venv/bin/python3 /pgadmin4/setup.py dump-servers /tmp/saved-servers.json --user "$PGADMIN_DEFAULT_EMAIL" >/dev/null && cat /tmp/saved-servers.json',
        );
        assert(exported.includes(marker), "pgAdmin saved server did not persist");
        break;
      }
      case "otel-collector": {
        const send = async () => {
          const startTime = String(BigInt(Date.now()) * 1_000_000n);
          const body = JSON.stringify({
            resourceSpans: [
              {
                scopeSpans: [
                  {
                    spans: [
                      {
                        traceId: randomBytes(16).toString("hex"),
                        spanId: randomBytes(8).toString("hex"),
                        name: marker,
                        kind: 1,
                        startTimeUnixNano: startTime,
                        endTimeUnixNano: startTime,
                      },
                    ],
                  },
                ],
              },
            ],
          });
          // The receiver stays private: use a disposable client on the project network.
          return docker(
            "run",
            "--rm",
            "--network",
            prefix,
            "--entrypoint",
            "wget",
            "caddy:2.11.7-alpine",
            "-q",
            "-O",
            "-",
            "--header=Content-Type: application/json",
            "--post-data=" + body,
            "http://otel-collector:4318/v1/traces",
          );
        };
        for (let i = 0; i < 20; i++) {
          try {
            await send();
            break;
          } catch (error) {
            if (i === 19) throw error;
            await pause(1000);
          }
        }
        await pause(1_500);
        const logs = await docker("logs", names.get("otel-collector")!);
        assert(
          logs.includes("Spans") || /"spans":\s*1/.test(logs),
          "Collector did not export a received span",
        );
        await replace();
        await pause(1_500);
        assert((await send()).includes("{}"), "Collector failed OTLP reception after replacement");
        break;
      }
      case "appwrite": {
        let password = env("appwrite", "OPENSHIP_ADMIN_PASSWORD");
        const login = async () => {
          const headers = { "X-Appwrite-Project": "console", "Content-Type": "application/json" };
          const response = await request("appwrite-gateway", "/v1/account/sessions/email", {
            method: "POST",
            headers,
            body: JSON.stringify({
              email: env("appwrite", "OPENSHIP_ADMIN_EMAIL"),
              password,
            }),
          });
          assert(
            response.status === 201,
            "Appwrite generated owner could not sign in (HTTP " + response.status + ")",
          );
          return {
            ...headers,
            Cookie: response.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
          };
        };
        let headers = await login();
        const signup = await request("appwrite-gateway", "/v1/account", {
          method: "POST",
          headers: { "X-Appwrite-Project": "console", "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "unique()",
            email: marker + "@example.com",
            password: randomBytes(32).toString("hex"),
            name: "Other",
          }),
        });
        assert(signup.status >= 400, "Appwrite allowed another anonymous Console owner");
        assert(
          (await request("appwrite-gateway", "/", { headers })).ok,
          "Appwrite Console did not load",
        );
        const name = await request("appwrite-gateway", "/v1/account/name", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: marker }),
        });
        assert(name.ok, "Appwrite owner could not update account");
        const create = async (path: string, body: unknown, scoped = headers) => {
          const response = await request("appwrite-gateway", "/v1/" + path, {
            method: "POST",
            headers: scoped,
            body: JSON.stringify(body),
          });
          assert(
            response.status === 201,
            "Appwrite " + path + " create failed (HTTP " + response.status + ")",
          );
          return (await response.json()) as any;
        };
        const team = await create("teams", { teamId: "unique()", name: marker });
        const project = await create("projects", {
          projectId: "unique()",
          name: marker,
          teamId: team.$id,
          region: "default",
        });
        const scoped = {
          ...headers,
          "X-Appwrite-Project": project.$id,
          "X-Appwrite-Mode": "admin",
        };
        const database = await create(
          "databases",
          { databaseId: "unique()", name: marker },
          scoped,
        );
        const bucket = await create(
          "storage/buckets",
          { bucketId: "unique()", name: marker, fileSecurity: false },
          scoped,
        );
        const form = new FormData();
        form.set("fileId", "unique()");
        form.set("file", new Blob([marker], { type: "text/plain" }), "smoke.txt");
        const { "Content-Type": _, ...uploadHeaders } = scoped;
        const upload = await request(
          "appwrite-gateway",
          "/v1/storage/buckets/" + bucket.$id + "/files",
          { method: "POST", headers: uploadHeaders, body: form },
        );
        assert(upload.status === 201, "Appwrite file upload failed");
        const storedFile = (await upload.json()) as any;
        const nextPassword = randomBytes(32).toString("hex");
        const changed = await request("appwrite-gateway", "/v1/account/password", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ password: nextPassword, oldPassword: password }),
        });
        assert(changed.ok, "Appwrite owner could not change the initial password");
        password = nextPassword;
        await replace();
        headers = await login();
        const account = await request("appwrite-gateway", "/v1/account", { headers });
        assert(
          account.ok && (await account.text()).includes(marker),
          "Appwrite overwrote owner data on redeploy",
        );
        const restored = {
          ...headers,
          "X-Appwrite-Project": project.$id,
          "X-Appwrite-Mode": "admin",
        };
        const savedDatabase = await request("appwrite-gateway", "/v1/databases/" + database.$id, {
          headers: restored,
        });
        assert(
          savedDatabase.ok && (await savedDatabase.text()).includes(marker),
          "Appwrite database did not persist",
        );
        const download = await request(
          "appwrite-gateway",
          "/v1/storage/buckets/" + bucket.$id + "/files/" + storedFile.$id + "/download",
          { headers: restored },
        );
        assert(
          download.ok && (await download.text()) === marker,
          "Appwrite stored file did not persist",
        );
        break;
      }

      case "ollama": {
        const model = "qwen3:0.6b";
        const pulled = await fetch(url("ollama", "/api/pull"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: model, stream: false }),
          signal: AbortSignal.timeout(600_000),
        });
        assert(pulled.ok, "Ollama model download failed");
        assert((await pulled.json() as { status?: string }).status === "success", "Ollama model download did not complete");
        const generated = await fetch(url("ollama", "/api/generate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: "Say hello.", stream: false, think: false, options: { num_predict: 8 } }),
          signal: AbortSignal.timeout(120_000),
        });
        assert(generated.ok && (await generated.json() as { response?: string }).response, "Ollama CPU inference failed");
        await replace();
        const models = await request("ollama", "/api/tags").then((response) => response.json()) as { models: { name: string }[] };
        assert(models.models.some((item) => item.name === model), "Ollama downloaded model did not persist");
        break;
      }
      case "open-webui": {
        const login = async () => {
          const response = await request("open-webui", "/api/v1/auths/signin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: env("open-webui", "WEBUI_ADMIN_EMAIL"), password: env("open-webui", "WEBUI_ADMIN_PASSWORD") }),
          });
          assert(response.ok, "Open WebUI generated admin login failed");
          const session = await response.json() as { token: string; role: string };
          assert(session.token && session.role === "admin", "Open WebUI initial account is not an administrator");
          return { Authorization: "Bearer " + session.token, "Content-Type": "application/json" };
        };
        const headers = await login();
        assert((await request("open-webui", "/api/v1/auths/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Blocked", email: "blocked@openship.io", password: randomBytes(32).toString("hex") }),
        })).status === 403, "Open WebUI public sign-up was not disabled");
        const response = await request("open-webui", "/api/v1/chats/new", {
          method: "POST", headers, body: JSON.stringify({ chat: { title: marker, messages: [] } }),
        });
        assert(response.ok, "Open WebUI authenticated chat creation failed");
        const chat = await response.json() as { id: string };
        await replace();
        const restored = await request("open-webui", "/api/v1/chats/" + chat.id, { headers: await login() });
        assert(restored.ok && (await restored.json() as { chat: { title: string } }).chat.title === marker, "Open WebUI chat did not persist");
        break;
      }
      case "homepage": {
        const response = await request("homepage-access", "/");
        assert(response.status === 401, "Homepage allowed unauthenticated public access");
        const headers = {
          Authorization: basic(
            env("homepage-access", "OPENSHIP_ADMIN_USER"),
            env("homepage-access", "OPENSHIP_ADMIN_PASSWORD"),
          ),
        };
        assert(
          (await request("homepage-access", "/", { headers })).ok,
          "Homepage protected login failed",
        );
        await exec("homepage", `printf '%s' 'title: ${marker}' > /app/config/settings.yaml`);
        await replace();
        assert(
          (await exec("homepage", "cat /app/config/settings.yaml")).includes(marker),
          "Homepage overwrote saved settings",
        );
        assert(
          (await request("homepage-access", "/")).status === 401,
          "Homepage lost authentication on redeploy",
        );
        assert(
          (await request("homepage-access", "/", { headers })).ok,
          "Homepage login failed after redeploy",
        );
        break;
      }
      case "jellyfin": {
        const authorization =
          'MediaBrowser Client="Openship", Device="Smoke", DeviceId="openship-smoke", Version="1"';
        const login = async (password: string) => {
          const response = await request("jellyfin", "/Users/AuthenticateByName", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authorization },
            body: JSON.stringify({
              Username: env("jellyfin", "OPENSHIP_ADMIN_USER"),
              Pw: password,
            }),
          });
          return response.ok ? ((await response.json()) as any) : null;
        };
        const session = await login(env("jellyfin", "OPENSHIP_ADMIN_PASSWORD"));
        assert(
          session?.AccessToken && session.User.Policy.IsAdministrator,
          "Jellyfin initial owner login failed",
        );
        const headers = {
          "Content-Type": "application/json",
          Authorization: authorization + ', Token="' + session.AccessToken + '"',
        };
        const changedPassword = randomBytes(32).toString("hex");
        assert(
          (
            await request("jellyfin", "/Users/Password?userId=" + session.User.Id, {
              method: "POST",
              headers,
              body: JSON.stringify({
                CurrentPw: env("jellyfin", "OPENSHIP_ADMIN_PASSWORD"),
                NewPw: changedPassword,
              }),
            })
          ).ok,
          "Jellyfin password change failed",
        );
        assert(
          (
            await request(
              "jellyfin",
              "/Library/VirtualFolders?name=Openship%20test&collectionType=music&refreshLibrary=false",
              {
                method: "POST",
                headers,
                body: JSON.stringify({ LibraryOptions: { PathInfos: [{ Path: "/media" }] } }),
              },
            )
          ).ok,
          "Jellyfin library creation failed",
        );
        await exec("jellyfin", `printf '%s' '${marker}' > /media/openship-smoke`);
        assert(
          !(
            await request("jellyfin", "/Startup/User", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ Name: "attacker", Password: "attacker-password" }),
            })
          ).ok,
          "Jellyfin left public first-owner setup open",
        );
        await replace();
        const restored = await login(changedPassword);
        assert(restored?.AccessToken, "Jellyfin reset the changed administrator password");
        assert(
          !(await login(env("jellyfin", "OPENSHIP_ADMIN_PASSWORD"))),
          "Jellyfin restored initial credentials",
        );
        const libraries = await request("jellyfin", "/Library/VirtualFolders", {
          headers: { Authorization: authorization + ', Token="' + restored.AccessToken + '"' },
        });
        assert(
          ((await libraries.json()) as any[]).some(
            (library) => library.Name === "Openship test" && library.Locations.includes("/media"),
          ),
          "Jellyfin library settings did not persist",
        );
        assert(
          (await exec("jellyfin", "cat /media/openship-smoke")) === marker,
          "Jellyfin media did not persist",
        );
        break;
      }
      case "wiki-js": {
        const graph = async (
          query: string,
          variables: Record<string, unknown> = {},
          token?: string,
        ) => {
          const response = await request("wiki", "/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: "Bearer " + token } : {}),
            },
            body: JSON.stringify({ query, variables }),
          });
          const result = (await response.json()) as any;
          assert(response.ok && !result.errors, "Wiki.js GraphQL request failed");
          return result.data;
        };
        const login = async (password: string) =>
          (
            await graph(
              'mutation($username:String!,$password:String!){authentication{login(username:$username,password:$password,strategy:"local"){responseResult{succeeded} jwt}}}',
              { username: env("wiki", "OPENSHIP_ADMIN_EMAIL"), password },
            )
          ).authentication.login;
        const owner = await login(env("wiki", "OPENSHIP_ADMIN_PASSWORD"));
        assert(owner.responseResult.succeeded && owner.jwt, "Wiki.js administrator login failed");
        const page = (
          await graph(
            'mutation($content:String!){pages{create(content:$content,description:"",editor:"markdown",isPublished:true,isPrivate:false,locale:"en",path:"openship-smoke",tags:[],title:"Openship smoke"){responseResult{succeeded} page{id}}}}',
            { content: marker },
            owner.jwt,
          )
        ).pages.create;
        assert(page.responseResult.succeeded, "Wiki.js page creation failed");
        const changedPassword = randomBytes(32).toString("hex");
        assert(
          (
            await graph(
              "mutation($current:String!,$new:String!){users{changePassword(current:$current,new:$new){responseResult{succeeded}}}}",
              { current: env("wiki", "OPENSHIP_ADMIN_PASSWORD"), new: changedPassword },
              owner.jwt,
            )
          ).users.changePassword.responseResult.succeeded,
          "Wiki.js password change failed",
        );
        await exec("wiki", `printf '%s' '${marker}' > /wiki/data/openship-smoke`);
        await replace();
        const restored = await login(changedPassword);
        assert(
          restored.responseResult.succeeded && restored.jwt,
          "Wiki.js reset the changed administrator password",
        );
        assert(
          !(await login(env("wiki", "OPENSHIP_ADMIN_PASSWORD"))).responseResult.succeeded,
          "Wiki.js restored initial credentials",
        );
        assert(
          (
            await graph(
              "query($id:Int!){pages{single(id:$id){content}}}",
              { id: page.page.id },
              restored.jwt,
            )
          ).pages.single.content === marker,
          "Wiki.js document did not persist",
        );
        assert(
          (await exec("wiki", "cat /wiki/data/openship-smoke")) === marker,
          "Wiki.js files did not persist",
        );
        break;
      }
      case "immich": {
        const login = async (password: string) => {
          const response = await request("immich", "/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: env("immich", "OPENSHIP_ADMIN_EMAIL"), password }),
          });
          return response.ok ? ((await response.json()) as any) : null;
        };
        const owner = await login(env("immich", "OPENSHIP_ADMIN_PASSWORD"));
        assert(owner?.accessToken && owner.isAdmin, "Immich administrator login failed");
        const headers = { Authorization: "Bearer " + owner.accessToken };
        const photo = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
          "base64",
        );
        const form = new FormData();
        form.set("assetData", new Blob([photo], { type: "image/png" }), marker + ".png");
        form.set("fileCreatedAt", new Date().toISOString());
        form.set("fileModifiedAt", new Date().toISOString());
        const upload = await request("immich", "/api/assets", {
          method: "POST",
          headers,
          body: form,
        });
        assert(upload.ok, "Immich photo upload failed");
        const asset = (await upload.json()) as any;
        assert(asset.id, "Immich upload did not return an asset");
        const changedPassword = randomBytes(32).toString("hex");
        assert(
          (
            await request("immich", "/api/auth/change-password", {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({
                password: env("immich", "OPENSHIP_ADMIN_PASSWORD"),
                newPassword: changedPassword,
              }),
            })
          ).ok,
          "Immich password change failed",
        );
        assert(
          !(
            await request("immich", "/api/auth/admin-sign-up", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email: "attacker@example.com",
                name: "Attacker",
                password: "attacker-password",
              }),
            })
          ).ok,
          "Immich left first-owner setup public",
        );
        await replace();
        const restored = await login(changedPassword);
        assert(restored?.accessToken, "Immich reset the changed administrator password");
        assert(
          !(await login(env("immich", "OPENSHIP_ADMIN_PASSWORD"))),
          "Immich restored initial credentials",
        );
        const original = await request("immich", "/api/assets/" + asset.id + "/original", {
          headers: { Authorization: "Bearer " + restored.accessToken },
        });
        assert(
          original.ok && Buffer.from(await original.arrayBuffer()).equals(photo),
          "Immich photo did not persist",
        );
        break;
      }
      case "paperless-ngx": {
        const login = async (password: string) => {
          const response = await request("paperless", "/api/token/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: env("paperless", "PAPERLESS_ADMIN_USER"), password }),
          });
          return response.ok ? ((await response.json()) as any) : null;
        };
        const owner = await login(env("paperless", "PAPERLESS_ADMIN_PASSWORD"));
        assert(owner?.token, "Paperless administrator login failed");
        const headers = { Authorization: "Token " + owner.token };
        // A real searchable PDF: the OCR pipeline must consume it, not merely accept an upload.
        const objects = [
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
          "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];
        const documentText = "Openship catalog verification";
        const stream = `BT /F1 20 Tf 30 80 Td (${documentText}) Tj ET`;
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
        let pdf = "%PDF-1.4\n";
        const offsets: number[] = [0];
        for (const [i, object] of objects.entries()) {
          offsets.push(Buffer.byteLength(pdf));
          pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
        }
        const xref = Buffer.byteLength(pdf);
        pdf +=
          `xref\n0 6\n0000000000 65535 f \n` +
          offsets
            .slice(1)
            .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
            .join("") +
          `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        const form = new FormData();
        form.set("document", new Blob([pdf], { type: "application/pdf" }), marker + ".pdf");
        form.set("title", marker);
        assert(
          (
            await request("paperless", "/api/documents/post_document/", {
              method: "POST",
              headers,
              body: form,
            })
          ).ok,
          "Paperless document upload failed",
        );
        let document: any;
        for (let i = 0; i < 120; i++) {
          const response = await request("paperless", "/api/documents/?query=" + encodeURIComponent("catalog verification"), {
            headers,
          });
          const result = (await response.json()) as any;
          document = result.results?.find((doc: any) => doc.title === marker);
          if (document?.content?.toLowerCase().includes("catalog verification")) break;
          await pause(2000);
        }
        assert(document?.content?.toLowerCase().includes("catalog verification"), "Paperless document consumption/search failed");
        const changedPassword = randomBytes(32).toString("hex");
        await exec(
          "paperless",
          "cd /usr/src/paperless/src && python manage.py shell -c " +
            quote(
              `from django.contrib.auth import get_user_model; import os; u = get_user_model().objects.get(username=os.environ['PAPERLESS_ADMIN_USER']); u.set_password('${changedPassword}'); u.save()`,
            ),
        );
        await replace();
        const restored = await login(changedPassword);
        assert(restored?.token, "Paperless reset the changed administrator password");
        assert(
          !(await login(env("paperless", "PAPERLESS_ADMIN_PASSWORD"))),
          "Paperless restored initial credentials",
        );
        const saved = await request(
          "paperless",
          "/api/documents/" + document.id + "/download/?original=true",
          { headers: { Authorization: "Token " + restored.token } },
        );
        assert(
          saved.ok && Buffer.from(await saved.arrayBuffer()).equals(Buffer.from(pdf)),
          "Paperless original document did not persist",
        );
        break;
      }
      case "wordpress": {
        const loginAs = (password: string) =>
          request("wordpress", "/wp-login.php", {
            method: "POST",
            redirect: "manual",
            body: new URLSearchParams({
              log: env("wordpress", "OPENSHIP_ADMIN_USER"),
              pwd: password,
              "wp-submit": "Log In",
              redirect_to: url("wordpress", "/wp-admin/"),
              testcookie: "1",
            }),
            headers: { Cookie: "wordpress_test_cookie=WP%20Cookie%20check" },
          });
        const login = await loginAs(env("wordpress", "OPENSHIP_ADMIN_PASSWORD"));
        assert(
          login.headers.getSetCookie().some((c) => c.startsWith("wordpress_logged_in_")),
          "WordPress admin login failed",
        );
        const php = (code: string) =>
          exec(
            "wordpress",
            "su -s /bin/sh www-data -c " +
              quote("php -r " + quote("require '/var/www/html/wp-load.php'; " + code)),
          );
        await php(`update_option('openship_smoke', '${marker}');`);
        const changedPassword = randomBytes(32).toString("hex");
        await php(
          `wp_set_password('${changedPassword}', get_user_by('login', getenv('OPENSHIP_ADMIN_USER'))->ID);`,
        );
        await exec(
          "wordpress",
          `printf '%s' '${marker}' > /var/www/html/wp-content/openship-smoke`,
        );
        await replace();
        assert(
          (await php("echo get_option('openship_smoke');")) === marker,
          "WordPress content did not persist",
        );
        assert(
          (await exec("wordpress", "cat /var/www/html/wp-content/openship-smoke")) === marker,
          "WordPress uploaded files did not persist",
        );
        assert(
          (await loginAs(changedPassword)).headers
            .getSetCookie()
            .some((c) => c.startsWith("wordpress_logged_in_")),
          "WordPress reset the administrator's changed password on redeploy",
        );
        assert(
          !(await loginAs(env("wordpress", "OPENSHIP_ADMIN_PASSWORD"))).headers
            .getSetCookie()
            .some((c) => c.startsWith("wordpress_logged_in_")),
          "WordPress restored the initial administrator password",
        );
        break;
      }
      case "odoo": {
        const login = await request("odoo", "/web/session/authenticate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "call",
            params: {
              db: "odoo",
              login: env("odoo", "OPENSHIP_ADMIN_EMAIL"),
              password: env("odoo", "OPENSHIP_ADMIN_PASSWORD"),
            },
          }),
        });
        assert(((await login.json()) as any).result?.uid, "Odoo administrator login failed");
        await exec(
          "odoo-db",
          `psql -U odoo -d odoo -c "INSERT INTO ir_config_parameter (key, value) VALUES ('openship_smoke', '${marker}')"`,
        );
        await exec("odoo", `printf '%s' '${marker}' > /var/lib/odoo/openship-smoke`);
        await replace();
        assert(
          (await exec(
            "odoo-db",
            "psql -U odoo -d odoo -Atc \"SELECT value FROM ir_config_parameter WHERE key = 'openship_smoke'\"",
          )) === marker,
          "Odoo database did not persist",
        );
        assert(
          (await exec("odoo", "cat /var/lib/odoo/openship-smoke")) === marker,
          "Odoo filestore volume did not persist",
        );
        break;
      }
      case "postgresql": {
        const appSql = (sql: string) =>
          exec(
            "postgres",
            'PGPASSWORD="$OPENSHIP_APP_PASSWORD" psql -h 127.0.0.1 -U app -d app -Atc ' +
              quote(sql),
          );
        assert(
          (await appSql(
            "SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user",
          )) === "false|false|false",
          "PostgreSQL application connection has administrative privileges",
        );
        const page = await request("pgadmin", "/login");
        const body = await page.text();
        const csrf =
          inputValue(body, "csrf_token") ?? /"csrfToken"\s*:\s*"([^"]+)"/.exec(body)?.[1];
        if (!csrf)
          await writeFile(join(tmpdir(), "openship-pgadmin-login-form.html"), body, {
            mode: 0o600,
          });
        assert(csrf, "pgAdmin login did not provide a CSRF token");
        const login = await request("pgadmin", "/login", {
          method: "POST",
          redirect: "manual",
          headers: {
            Cookie: page.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
            "Content-Type": "application/json",
            "X-CSRFToken": csrf,
          },
          body: JSON.stringify({
            email: env("pgadmin", "PGADMIN_DEFAULT_EMAIL"),
            password: env("pgadmin", "PGADMIN_DEFAULT_PASSWORD"),
          }),
        });
        const cookies = new Map(
          [...page.headers.getSetCookie(), ...login.headers.getSetCookie()].map((c) => {
            const pair = c.split(";")[0]!;
            return [pair.split("=")[0], pair] as const;
          }),
        );
        const browser = await request("pgadmin", "/browser/", {
          redirect: "manual",
          headers: { Cookie: [...cookies.values()].join("; ") },
        });
        assert(
          browser.status === 200 && !browser.headers.get("Location"),
          "pgAdmin administrator login failed (HTTP " + login.status + ")",
        );
        await appSql(
          `CREATE TABLE openship_smoke (value text); INSERT INTO openship_smoke VALUES ('${marker}')`,
        );
        await replace();
        assert(
          (await appSql("SELECT value FROM openship_smoke")) === marker,
          "PostgreSQL data did not persist",
        );
        break;
      }
      case "mariadb": {
        const page = await request("adminer", "/");
        const form = await page.text();
        const token = inputValue(form, "token");
        assert(token, "Adminer login did not provide a CSRF token");
        const login = await request("adminer", "/", {
          method: "POST",
          redirect: "manual",
          headers: {
            Cookie: page.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
          },
          body: new URLSearchParams({
            token,
            "auth[driver]": "server",
            "auth[server]": "MariaDB",
            "auth[username]": "openship",
            "auth[password]": env("mariadb", "MARIADB_PASSWORD"),
            "auth[db]": "app",
          }),
        });
        assert(
          [302, 303].includes(login.status) &&
            login.headers.get("Location")?.includes("username=openship"),
          "Adminer database login failed (HTTP " + login.status + ")",
        );
        await exec(
          "mariadb",
          `mariadb -u openship -p"$MARIADB_PASSWORD" app -e "CREATE TABLE openship_smoke (value text); INSERT INTO openship_smoke VALUES ('${marker}')"`,
        );
        await replace();
        assert(
          (await exec(
            "mariadb",
            "mariadb -N -s -u openship -p\"$MARIADB_PASSWORD\" app -e 'SELECT value FROM openship_smoke'",
          )) === marker,
          "MariaDB data did not persist",
        );
        break;
      }
      case "rabbitmq": {
        const headers = {
          Authorization: basic("openship", env("rabbitmq", "RABBITMQ_DEFAULT_PASS")),
          "Content-Type": "application/json",
        };
        assert(
          (await request("rabbitmq", "/api/overview")).status === 401,
          "RabbitMQ permits unauthenticated administration",
        );
        assert(
          (await request("rabbitmq", "/api/overview", { headers })).ok,
          "RabbitMQ administrator login failed",
        );
        assert(
          (
            await request("rabbitmq", "/api/queues/openship/smoke", {
              method: "PUT",
              headers,
              body: JSON.stringify({ durable: true, auto_delete: false, arguments: {} }),
            })
          ).ok,
          "RabbitMQ queue creation failed",
        );
        const published = await request("rabbitmq", "/api/exchanges/openship/amq.default/publish", {
          method: "POST",
          headers,
          body: JSON.stringify({
            properties: { delivery_mode: 2 },
            routing_key: "smoke",
            payload: marker,
            payload_encoding: "string",
          }),
        });
        assert(((await published.json()) as any).routed, "RabbitMQ did not route the message");
        await replace();
        const message = await request("rabbitmq", "/api/queues/openship/smoke/get", {
          method: "POST",
          headers,
          body: JSON.stringify({
            count: 1,
            ackmode: "ack_requeue_true",
            encoding: "auto",
            truncate: 1000,
          }),
        });
        assert(
          ((await message.json()) as any)[0]?.payload === marker,
          "RabbitMQ persistent message did not survive replacement",
        );
        break;
      }
      case "authentik": {
        // Check the actual stored password with Authentik's own Django API;
        // the web UI uses this same authentication backend.
        const result = await exec(
          "authentik-worker",
          'ak shell -c \'import os; from authentik.core.models import User; u=User.objects.get(username="akadmin"); assert u.check_password(os.environ["AUTHENTIK_BOOTSTRAP_PASSWORD"]); print("admin-ok")\'',
        );
        assert(result.includes("admin-ok"), "Authentik bootstrap login failed");
        assert(
          (await request("authentik", "/if/flow/default-authentication-flow/")).ok,
          "Authentik login page is unavailable",
        );
        await exec(
          "authentik-db",
          `psql -U authentik -d authentik -c "CREATE TABLE openship_smoke (value text); INSERT INTO openship_smoke VALUES ('${marker}')"`,
        );
        await replace();
        assert(
          (await exec(
            "authentik-db",
            "psql -U authentik -d authentik -Atc 'SELECT value FROM openship_smoke'",
          )) === marker,
          "Authentik data did not persist",
        );
        break;
      }
      case "nextcloud": {
        const headers = {
          Authorization: basic("admin", env("nextcloud", "NEXTCLOUD_ADMIN_PASSWORD")),
        };
        const path = "/remote.php/dav/files/admin/openship-smoke.txt";
        assert(
          (await request("nextcloud", path, { method: "PUT", headers, body: marker })).ok,
          "Nextcloud authenticated file upload failed",
        );
        assert(
          (await exec(
            "nextcloud",
            "su -s /bin/sh www-data -c 'php occ config:app:get core backgroundjobs_mode'",
          )) === "cron",
          "Nextcloud did not enable scheduled jobs",
        );
        await replace();
        assert(
          (await request("nextcloud", path, { headers })).status === 200 &&
            (await request("nextcloud", path, { headers }).then((r) => r.text())) === marker,
          "Nextcloud uploaded file did not persist",
        );
        break;
      }
    }
    console.log(app.id + ": startup, credentials, application access and persistence passed");
  } catch (error) {
    const logs: string[] = [];
    for (const [service, name] of names) {
      const output = await run("docker", ["logs", "--tail", "40", name], {
        timeout: 10_000,
        maxBuffer: 512_000,
      }).catch(() => null);
      if (output) logs.push(service + ":\n" + output.stdout + output.stderr);
    }
    const sanitized = [...config.values()]
      .filter((v) => v.length >= 24)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), logs.join("\n"));
    const logPath = join(tmpdir(), "openship-catalog-smoke-" + app.id + "-failure.log");
    await writeFile(logPath, sanitized, { mode: 0o600 });
    console.error("Sanitized startup logs: " + logPath);
    throw error;
  } finally {
    operation = app.id + "/cleanup";
    for (const name of [...names.values()].reverse())
      await docker("rm", "-f", name).catch(() => {});
    for (const volume of volumes.values()) await docker("volume", "rm", volume).catch(() => {});
    for (const volume of configVolumes.values())
      await docker("volume", "rm", volume).catch(() => {});
    await docker("network", "rm", prefix).catch(() => {});
    for (const image of generatedImages) await docker("image", "rm", image).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const selected = process.argv.slice(2);
    for (const id of selected.length ? selected : OFFICIAL_APP_STACKS) {
      const app = buildCatalog().apps.find((a) => a.id === id);
      assert(
        app?.services?.length && OFFICIAL_APP_STACKS.includes(id as any),
        "Unknown smoke-test app: " + id,
      );
      console.log(id + ": testing canonical catalog stack");
      await smokeApp(app);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Catalog stack smoke failed");
    process.exitCode = 1;
  }
}

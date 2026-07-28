/**
 * Import a containerized Traefik's routes into normalized ImportedSites.
 *
 * Traefik is LABEL-driven: app containers carry
 *   traefik.http.routers.<r>.rule    = Host(`a.com`) [&& PathPrefix(`/api`)]
 *   traefik.http.routers.<r>.service = <svc>
 *   traefik.http.routers.<r>.tls     = true
 *   traefik.http.services.<svc>.loadbalancer.server.port = 3000
 * Traefik discovers these across ALL containers, so the caller passes every
 * container's labels + its resolved IP. This module is PURE (no I/O) — the
 * docker-inspect that gathers the inputs lives in the scan wrapper.
 *
 * An OpenResty vhost carries ONE upstream per host, so only the Host() part
 * migrates; PathPrefix / Headers / Method / middlewares / HostRegexp are
 * surfaced as coverage warnings ("re-add manually"), never silently dropped.
 */

import type { CommandExecutor } from "../../../types";
import type { ImportedSite, ProxyScanResult } from "../../types";
import { tryExec } from "./parse-utils";

export interface TraefikContainer {
  /** Container name — for the ImportedSite.source trace. */
  name: string;
  /** All docker labels on the container. */
  labels: Record<string, string>;
  /** Resolved container IP (from docker inspect) for the upstream URL. */
  ip?: string;
}

/** Pull backtick- (or quote-) quoted hostnames out of a `Host(...)` matcher. */
function extractHosts(rule: string): string[] {
  const hosts: string[] = [];
  // Host(`a.com`, `b.com`) — traefik uses backticks; tolerate quotes too.
  for (const call of rule.matchAll(/\bHost\(([^)]*)\)/gi)) {
    for (const m of call[1].matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
      const h = m[1].trim();
      if (h) hosts.push(h);
    }
  }
  return hosts;
}

/** Matchers other than Host() that a single-upstream OpenResty vhost can't express. */
function extraMatchers(rule: string): string[] {
  const found = new Set<string>();
  for (const m of rule.matchAll(
    /\b(PathPrefix|PathRegexp|Path|HeadersRegexp|Headers|Method|Query|ClientIP|HostRegexp)\b/gi,
  )) {
    found.add(m[1]);
  }
  return [...found];
}

export function parseTraefikLabels(containers: TraefikContainer[]): ProxyScanResult {
  const sites: ImportedSite[] = [];
  const warnings: string[] = [];

  for (const c of containers) {
    if (c.labels["traefik.enable"] === "false") continue; // opted out

    const routers = new Map<string, Record<string, string>>();
    const servicePorts = new Map<string, string>();
    for (const [key, val] of Object.entries(c.labels)) {
      const r = key.match(/^traefik\.http\.routers\.([^.]+)\.(.+)$/);
      if (r) {
        const bag = routers.get(r[1]) ?? {};
        bag[r[2]] = val;
        routers.set(r[1], bag);
        continue;
      }
      const s = key.match(/^traefik\.http\.services\.([^.]+)\.loadbalancer\.server\.port$/);
      if (s) servicePorts.set(s[1], val);
    }

    for (const [rname, props] of routers) {
      const rule = props.rule;
      if (!rule) continue;

      const hosts = extractHosts(rule);
      if (hosts.length === 0) {
        warnings.push(
          /HostRegexp/i.test(rule)
            ? `traefik: router "${rname}" uses HostRegexp (${rule}) — regex hosts aren't migratable`
            : `traefik: router "${rname}" has no Host() rule (${rule}) — skipped`,
        );
        continue;
      }

      if (!c.ip) {
        warnings.push(
          `traefik: ${hosts.join(", ")} — couldn't resolve container ${c.name}'s IP; re-add the upstream manually`,
        );
        continue;
      }

      // Upstream port: the router's service port → the only service → default 80.
      const svc = props.service;
      const rawPort =
        (svc && servicePorts.get(svc)) ??
        (servicePorts.size === 1 ? [...servicePorts.values()][0] : undefined) ??
        "80";
      // The port originates from a container label — accept only digits so it
      // can't inject characters into the generated proxy target (defence-in-depth;
      // the nginx layer rejects them too).
      const port = /^\d{1,5}$/.test(String(rawPort)) ? String(rawPort) : "80";
      const url = `http://${c.ip}:${port}`;

      const extras = extraMatchers(rule);
      if (extras.length > 0) {
        warnings.push(
          `traefik: ${hosts.join(", ")} also matches ${extras.join(", ")} — only the Host() part is migrated; re-add path/header rules manually`,
        );
      }
      if (props.middlewares) {
        warnings.push(`traefik: ${hosts.join(", ")} uses middleware(s) "${props.middlewares}" — not migrated`);
      }

      const ssl = Object.keys(props).some((p) => p === "tls" || p.startsWith("tls."));
      sites.push({
        serverNames: hosts,
        ssl,
        target: { kind: "proxy", url },
        source: `traefik container ${c.name}`,
      });
    }
  }

  return { proxy: "traefik", sites, warnings };
}

/**
 * I/O wrapper: gather every running container's labels + IP via `docker inspect`
 * (traefik routers can live on ANY container, not just the traefik one), then
 * run the pure parser. Executor-based (docker CLI) so the proxy module stays free
 * of a DockerRuntime dependency. Best-effort — never throws.
 */
export async function scanTraefik(executor: CommandExecutor): Promise<ProxyScanResult> {
  const out = await tryExec(
    executor,
    "docker ps -q 2>/dev/null | xargs -r docker inspect " +
      "--format '{{.Name}}\t{{json .Config.Labels}}\t{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null",
  );
  if (!out) {
    return { proxy: "traefik", sites: [], warnings: ["traefik: couldn't read container labels via docker inspect"] };
  }

  const containers: TraefikContainer[] = [];
  for (const line of out.split("\n")) {
    const [rawName, rawLabels, rawIps] = line.split("\t");
    if (!rawName || !rawLabels) continue;
    let labels: Record<string, string>;
    try {
      labels = (JSON.parse(rawLabels) as Record<string, string>) ?? {};
    } catch {
      continue;
    }
    if (!Object.keys(labels).some((k) => k.startsWith("traefik."))) continue; // only traefik-labeled
    const ip = (rawIps ?? "").trim().split(/\s+/)[0] || undefined;
    containers.push({ name: rawName.replace(/^\//, ""), labels, ip });
  }
  return parseTraefikLabels(containers);
}

/**
 * Docker Compose parser — extracts services, ports, volumes, depends_on,
 * and environment from a docker-compose.yml / compose.yml file.
 *
 * Used by the prepare service to populate the services UI for compose projects.
 */

import { parse as parseYaml } from "yaml";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  ports: string[];
  dependsOn: string[];
  environment: Record<string, string>;
  volumes: string[];
}

export interface ComposeParseResult {
  services: ComposeService[];
  volumes: string[];
  networks: string[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseComposeFile(content: string): ComposeParseResult {
  const doc = parseYaml(content);

  if (!doc || typeof doc !== "object") {
    return { services: [], volumes: [], networks: [] };
  }

  const rawServices = doc.services ?? {};
  const services: ComposeService[] = [];

  for (const [name, def] of Object.entries(rawServices)) {
    if (!def || typeof def !== "object") continue;
    const svc = def as Record<string, unknown>;

    services.push({
      name,
      image: typeof svc.image === "string" ? svc.image : undefined,
      build: parseBuild(svc.build),
      ports: parsePorts(svc.ports),
      dependsOn: parseDependsOn(svc.depends_on),
      environment: parseEnvironment(svc.environment),
      volumes: parseVolumes(svc.volumes),
    });
  }

  const volumes = doc.volumes ? Object.keys(doc.volumes) : [];
  const networks = doc.networks ? Object.keys(doc.networks) : [];

  return { services, volumes, networks };
}

// ─── Field parsers ───────────────────────────────────────────────────────────

function parseBuild(build: unknown): string | undefined {
  if (typeof build === "string") return build;
  if (build && typeof build === "object") {
    const b = build as Record<string, unknown>;
    return (typeof b.context === "string" ? b.context : undefined) ?? ".";
  }
  return undefined;
}

function parsePorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    if (typeof p === "string") return p;
    if (typeof p === "number") return String(p);
    if (p && typeof p === "object") {
      const port = p as Record<string, unknown>;
      const target = port.target ?? port.container_port;
      const published = port.published ?? port.host_port;
      if (target) {
        return published ? `${published}:${target}` : String(target);
      }
    }
    return String(p);
  });
}

function parseDependsOn(deps: unknown): string[] {
  if (Array.isArray(deps)) return deps.filter((d): d is string => typeof d === "string");
  if (deps && typeof deps === "object") return Object.keys(deps);
  return [];
}

function parseEnvironment(env: unknown): Record<string, string> {
  if (!env) return {};

  // Array form: ["KEY=value", "KEY2=value2"]
  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const eqIdx = item.indexOf("=");
      if (eqIdx > 0) {
        result[item.slice(0, eqIdx)] = item.slice(eqIdx + 1);
      } else {
        result[item] = "";
      }
    }
    return result;
  }

  // Object form: { KEY: value }
  if (typeof env === "object") {
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(env as Record<string, unknown>)) {
      result[key] = val != null ? String(val) : "";
    }
    return result;
  }

  return {};
}

function parseVolumes(vols: unknown): string[] {
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const vol = v as Record<string, unknown>;
      const src = vol.source ?? vol.name;
      const tgt = vol.target;
      if (src && tgt) return `${src}:${tgt}`;
      if (tgt) return String(tgt);
    }
    return String(v);
  });
}

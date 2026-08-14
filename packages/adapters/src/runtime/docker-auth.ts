import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type Dockerode from "dockerode";

type DockerConfig = {
  auths?: Record<string, { auth?: string; identitytoken?: string }>;
  credHelpers?: Record<string, string>;
  credsStore?: string;
};

const DOCKER_HUB_KEYS = ["https://index.docker.io/v1/", "index.docker.io", "docker.io"];

/** Return the registry addressed by an image reference. */
export function registryForImage(ref: string): string {
  const first = ref.split("/", 1)[0];
  return first.includes(".") || first.includes(":") || first === "localhost" ? first : "docker.io";
}

function matchingKey<T>(values: Record<string, T> | undefined, registry: string): string | undefined {
  if (!values) return undefined;
  if (registry !== "docker.io") return Object.hasOwn(values, registry) ? registry : undefined;
  return DOCKER_HUB_KEYS.find((key) => Object.hasOwn(values, key));
}

/** Resolve Docker CLI credentials for an image without exposing credential-provider output. */
export async function resolveDockerAuth(ref: string): Promise<Dockerode.AuthConfig | undefined> {
  const registry = registryForImage(ref);
  const configPath = join(process.env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json");
  let config: DockerConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as DockerConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Docker credential configuration is invalid for ${registry}`);
  }

  if (matchingKey(config.credHelpers, registry) || config.credsStore) {
    throw new Error(`Docker credential helper is unavailable for ${registry}; use inline auths`);
  }

  const authKey = matchingKey(config.auths, registry);
  const entry = authKey ? config.auths![authKey] : undefined;
  if (!entry) return undefined;
  if (entry.identitytoken) return { identitytoken: entry.identitytoken, serveraddress: authKey };
  if (!entry.auth) return undefined;

  try {
    const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) throw new Error("invalid auth");
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
      serveraddress: authKey,
    };
  } catch {
    throw new Error(`Docker credential configuration is invalid for ${registry}`);
  }
}

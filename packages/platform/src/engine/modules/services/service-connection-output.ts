import { detectDbImage, effectiveServiceAlias, hasUnresolvedPlaceholder, normalizeImageRef, shellSplitWords, type ComposeAdvanced } from "@repo/core";
import type { Service } from "@repo/db";
import type { AppConnectionOutput } from "../apps/app-settings.service";

/** One connection surface for project services, also used by catalog apps. */
export function serviceConnectionOutput(
  service: Service,
  port: number,
  env: Record<string, string>,
): AppConnectionOutput {
  const alias = effectiveServiceAlias(service.name, (service.advanced as ComposeAdvanced | null)?.alias);
  const output: AppConnectionOutput = {
    id: `${service.id}:url`,
    sourceServiceId: service.id,
    label: service.name,
    service: alias,
    internal: true,
    secret: false,
    value: `http://${alias}:${port}`,
    envKey: `${alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL`,
    width: "full",
  };
  const image = normalizeImageRef(service.image ?? "");
  const isValkey = /^valkey\/valkey(?::|$)/.test(image);
  // RedisInsight is an HTTP UI in the Redis namespace, not a Redis server.
  const kind = isValkey ? "redis_rdb" : /^redis\/redisinsight(?::|$)/.test(image) ? undefined : detectDbImage(service.image)?.payloadKind;
  const uri = (scheme: string, user: string, password: string, database: string, query = "") => {
    if ([user, password, database].some(value => hasUnresolvedPlaceholder(value) || /\$\{[^}]+\}/.test(value))) return "";
    return `${scheme}://${user || password ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@` : ""}${alias}:${port}/${encodeURIComponent(database)}${query}`;
  };

  if (kind === "pg_dump") {
    const user = env.POSTGRES_USER || "postgres";
    const password = env.POSTGRES_PASSWORD || "";
    output.envKey = "DATABASE_URL";
    output.secret = true;
    output.value = password || env.POSTGRES_HOST_AUTH_METHOD === "trust"
      ? uri("postgresql", user, password, env.POSTGRES_DB || user)
      : "";
  } else if (kind === "mysql_dump") {
    const user = env.MARIADB_USER || env.MYSQL_USER || "root";
    const password = user === "root"
      ? env.MARIADB_ROOT_PASSWORD || env.MYSQL_ROOT_PASSWORD || ""
      : env.MARIADB_PASSWORD || env.MYSQL_PASSWORD || "";
    output.envKey = "DATABASE_URL";
    output.secret = true;
    output.value = password || env.MYSQL_ALLOW_EMPTY_PASSWORD || env.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD
      ? uri("mysql", user, password, env.MARIADB_DATABASE || env.MYSQL_DATABASE || "")
      : "";
  } else if (kind === "mongo_dump") {
    const user = env.MONGO_INITDB_ROOT_USERNAME || "";
    const password = env.MONGO_INITDB_ROOT_PASSWORD || "";
    output.envKey = "MONGODB_URI";
    output.secret = !!(user || password);
    output.value = !!user !== !!password ? "" : uri(
      "mongodb", user, password, env.MONGO_INITDB_DATABASE || "", user ? "?authSource=admin" : "",
    );
  } else if (kind === "redis_rdb") {
    output.envKey = "REDIS_URL";
    // The upstream Redis image does not read REDIS_PASSWORD. Only include a
    // password when the actual command enables authentication.
    const argv = service.commandArgv;
    const shellIndex = argv && /(?:^|\/)(?:sh|bash|ash|dash)$/.test(argv[0] ?? "")
      ? argv.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
    const command = service.startCommand || (argv == null ? service.command : shellIndex >= 0 ? argv[shellIndex + 1] : "") || "";
    const args = [...(argv ?? []), ...(isValkey ? shellSplitWords(env.VALKEY_EXTRA_FLAGS ?? "") : [])];
    const index = args.findIndex(arg => arg === "--requirepass" || arg.startsWith("--requirepass="));
    const match = command.match(/--requirepass(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/);
    let password = index >= 0
      ? args[index].startsWith("--requirepass=") ? args[index].slice("--requirepass=".length) : args[index + 1]
      : match?.[1] ?? match?.[2] ?? match?.[3];
    // Exec argv is literal. Expand only a shell command's unquoted/double-quoted
    // value, matching the deployment runtime rather than guessing from env names.
    if (password && index < 0 && match?.[2] === undefined) {
      password = password.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => env[a ?? b] ?? "");
    }
    const configuration = [...args, command].join(" ");
    const usesConfig = /\.conf(?:\s|$)|--aclfile|--user(?:\s|=)/.test(configuration);
    output.secret = !!password;
    output.value = usesConfig || (/--requirepass(?:\s|=|$)/.test(configuration) && !password)
      ? "" : uri("redis", "", password || "", "0");
  }

  // A file-backed secret, missing required value, or unresolved interpolation
  // needs configuration. Never hand a consumer a plausible but invalid URL.
  if (hasUnresolvedPlaceholder(output.value) || /\$\{[^}]+\}/.test(output.value)) output.value = "";
  if (!output.value) output.help = "Configure this service's connection credentials before connecting it.";
  return output;
}
